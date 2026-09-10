// RV7.1 (Code-3kl.1) — typed client for the herdr Unix socket API.
//
// Wire format: newline-delimited JSON over a Unix socket at HERDR_SOCKET_PATH.
// Each request: {"id":"<uuid>","method":"<method>","params":{...}}
// Each response: {"id":"<uuid>","result":{...}} or {"id":"<uuid>","error":{"code":"...","message":"..."}}
//
// All methods are 100% behind herdr_mode=true; the rest of the app never calls
// this module when herdr is absent. Errors are propagated as String so the
// conductor can log and fall back to the in-process path.
//
// Only the methods the conductor needs are implemented:
//   agent.start, agent.read, agent.send_keys, agent.prompt, agent.wait,
//   agent.focus, pane.split, worktree.create, worktree.remove

// This module intentionally defines the complete protocol slice planned for
// the bounded Herdr evaluation. The conductor currently consumes only the
// launch/prompt path; keep the remaining typed operations available without
// turning every ordinary Cargo invocation into a wall of dead-code warnings.
#![allow(dead_code)]

use std::env;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

/// A conductor RPC must not hold a scheduling slot indefinitely. This bounds
/// connect, write, and response handling as one operation. A timeout after a
/// write is deliberately reported as ambiguous: callers must reconcile the
/// named attempt instead of replaying a launch or prompt.
pub const RPC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

// ---- AgentStatus (verbatim from herdr schema) ----

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Idle,
    Working,
    Blocked,
    Done,
    Unknown,
}

impl std::fmt::Display for AgentStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            AgentStatus::Idle => "idle",
            AgentStatus::Working => "working",
            AgentStatus::Blocked => "blocked",
            AgentStatus::Done => "done",
            AgentStatus::Unknown => "unknown",
        };
        write!(f, "{s}")
    }
}

// ---- Wire types ----

#[derive(Serialize)]
struct Request<P: Serialize> {
    id: String,
    method: &'static str,
    params: P,
}

#[derive(Deserialize)]
struct Response {
    id: String,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<ErrorBody>,
}

#[derive(Deserialize, Debug)]
struct ErrorBody {
    code: String,
    message: String,
}

// ---- Param types (schema-derived) ----

#[derive(Serialize)]
pub struct AgentStartParams {
    pub name: String,
    pub kind: String,
    pub pane_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
}

#[derive(Serialize)]
pub struct AgentReadParams {
    pub target: String,
    pub source: ReadSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<u32>,
    #[serde(default = "default_true")]
    pub strip_ansi: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadSource {
    Visible,
    Recent,
    RecentUnwrapped,
    Detection,
}

#[derive(Serialize)]
pub struct AgentSendKeysParams {
    pub target: String,
    pub keys: Vec<String>,
}

#[derive(Serialize)]
pub struct AgentPromptParams {
    pub target: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait: Option<AgentPromptWaitOptions>,
}

#[derive(Serialize)]
pub struct AgentPromptWaitOptions {
    pub until: Vec<AgentStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

#[derive(Serialize)]
pub struct AgentWaitParams {
    pub target: String,
    pub until: Vec<AgentStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

#[derive(Serialize)]
pub struct AgentTargetParams {
    pub target: String,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SplitDirection {
    Horizontal,
    Vertical,
}

#[derive(Serialize)]
pub struct PaneSplitParams {
    pub direction: SplitDirection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub focus: bool,
}

#[derive(Serialize)]
pub struct WorktreeCreateParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub focus: bool,
}

#[derive(Serialize)]
pub struct WorktreeRemoveParams {
    pub workspace_id: String,
    pub force: bool,
}

// ---- Result types ----

#[derive(Deserialize, Debug)]
pub struct PaneSplitResult {
    pub pane_id: String,
}

#[derive(Deserialize, Debug)]
pub struct AgentReadResult {
    pub output: String,
}

#[derive(Deserialize, Debug)]
pub struct AgentWaitResult {
    pub status: AgentStatus,
}

#[derive(Deserialize, Debug)]
pub struct WorktreeCreateResult {
    pub workspace_id: String,
}

// ---- Socket path resolution ----

pub fn socket_path() -> Option<PathBuf> {
    env::var("HERDR_SOCKET_PATH").ok().map(PathBuf::from)
}

pub fn is_available() -> bool {
    socket_path().map(|p| p.exists()).unwrap_or(false)
}

// ---- Low-level transport ----

/// Send one request, read one response line. Both are newline-delimited JSON.
/// Returns the parsed `result` Value on success, or a String error.
async fn call<P: Serialize>(method: &'static str, params: P) -> Result<Value, String> {
    let path = socket_path().ok_or_else(|| "HERDR_SOCKET_PATH not set".to_string())?;
    call_at_path(&path, method, params).await
}

async fn call_at_path<P: Serialize>(
    path: &std::path::Path,
    method: &'static str,
    params: P,
) -> Result<Value, String> {
    call_at_path_with_timeout(path, method, params, RPC_TIMEOUT).await
}

async fn call_at_path_with_timeout<P: Serialize>(
    path: &std::path::Path,
    method: &'static str,
    params: P,
    timeout: std::time::Duration,
) -> Result<Value, String> {
    let request = async {
        let mut stream = UnixStream::connect(path)
            .await
            .map_err(|e| format!("herdr connect {}: {e}", path.display()))?;

        let id = uuid::Uuid::new_v4().to_string();
        let req = Request {
            id: id.clone(),
            method,
            params,
        };
        let mut line = serde_json::to_string(&req).map_err(|e| format!("herdr serialize: {e}"))?;
        line.push('\n');

        stream
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("herdr write: {e}"))?;

        let mut reader = BufReader::new(stream);
        let mut resp_line = String::new();
        let bytes = reader
            .read_line(&mut resp_line)
            .await
            .map_err(|e| format!("herdr read: {e}"))?;
        if bytes == 0 {
            return Err("herdr read: connection closed before a response".to_string());
        }

        let resp: Response = serde_json::from_str(resp_line.trim())
            .map_err(|e| format!("herdr parse: {e} — raw: {resp_line}"))?;

        if resp.id != id {
            return Err(format!(
                "herdr: response id mismatch: got {} want {id}",
                resp.id
            ));
        }

        if let Some(err) = resp.error {
            return Err(format!("herdr error {}: {}", err.code, err.message));
        }

        Ok(resp.result.unwrap_or(Value::Null))
    };

    tokio::time::timeout(timeout, request)
        .await
        .map_err(|_| {
            format!(
                "herdr {method} timed out after {}s; request outcome is unknown, do not retry automatically",
                timeout.as_secs()
            )
        })?
}

// ---- Public API methods ----

pub async fn agent_start(params: AgentStartParams) -> Result<(), String> {
    call("agent.start", params).await?;
    Ok(())
}

pub async fn agent_read(params: AgentReadParams) -> Result<String, String> {
    let v = call("agent.read", params).await?;
    let output = v
        .get("output")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    Ok(output)
}

pub async fn agent_send_keys(params: AgentSendKeysParams) -> Result<(), String> {
    call("agent.send_keys", params).await?;
    Ok(())
}

/// Send a prompt and optionally wait for a terminal state. Returns the agent
/// status after the wait (or `Unknown` if no wait was requested).
pub async fn agent_prompt(params: AgentPromptParams) -> Result<AgentStatus, String> {
    let v = call("agent.prompt", params).await?;
    let status = v
        .get("status")
        .and_then(|s| serde_json::from_value(s.clone()).ok())
        .unwrap_or(AgentStatus::Unknown);
    Ok(status)
}

pub async fn agent_wait(params: AgentWaitParams) -> Result<AgentStatus, String> {
    let v = call("agent.wait", params).await?;
    let status = v
        .get("status")
        .and_then(|s| serde_json::from_value(s.clone()).ok())
        .unwrap_or(AgentStatus::Unknown);
    Ok(status)
}

pub async fn agent_focus(target: &str) -> Result<(), String> {
    call(
        "agent.focus",
        AgentTargetParams {
            target: target.to_string(),
        },
    )
    .await?;
    Ok(())
}

pub async fn pane_split(params: PaneSplitParams) -> Result<String, String> {
    let v = call("pane.split", params).await?;
    v.get("pane_id")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "herdr pane.split: no pane_id in response".to_string())
}

pub async fn worktree_create(params: WorktreeCreateParams) -> Result<String, String> {
    let v = call("worktree.create", params).await?;
    v.get("workspace_id")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "herdr worktree.create: no workspace_id in response".to_string())
}

pub async fn worktree_remove(params: WorktreeRemoveParams) -> Result<(), String> {
    call("worktree.remove", params).await?;
    Ok(())
}

// ---- Unit tests (wire encode/decode; no live socket needed) ----

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_status_serde_roundtrip() {
        for (status, wire) in [
            (AgentStatus::Idle, "\"idle\""),
            (AgentStatus::Working, "\"working\""),
            (AgentStatus::Blocked, "\"blocked\""),
            (AgentStatus::Done, "\"done\""),
            (AgentStatus::Unknown, "\"unknown\""),
        ] {
            let serialized = serde_json::to_string(&status).unwrap();
            assert_eq!(serialized, wire, "serialize {status}");
            let deserialized: AgentStatus = serde_json::from_str(wire).unwrap();
            assert_eq!(deserialized, status, "deserialize {wire}");
        }
    }

    #[test]
    fn agent_status_display() {
        assert_eq!(AgentStatus::Blocked.to_string(), "blocked");
        assert_eq!(AgentStatus::Done.to_string(), "done");
    }

    #[test]
    fn request_wire_shape() {
        let req = Request {
            id: "test-id".to_string(),
            method: "agent.wait",
            params: AgentWaitParams {
                target: "pane-123".to_string(),
                until: vec![AgentStatus::Blocked, AgentStatus::Done],
                timeout_ms: Some(30_000),
            },
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["id"], "test-id");
        assert_eq!(json["method"], "agent.wait");
        assert_eq!(json["params"]["target"], "pane-123");
        assert_eq!(json["params"]["until"][0], "blocked");
        assert_eq!(json["params"]["until"][1], "done");
        assert_eq!(json["params"]["timeout_ms"], 30_000u64);
    }

    #[test]
    fn agent_prompt_with_wait_serializes() {
        let params = AgentPromptParams {
            target: "agent-abc".to_string(),
            text: "do the thing".to_string(),
            wait: Some(AgentPromptWaitOptions {
                until: vec![AgentStatus::Blocked, AgentStatus::Done],
                timeout_ms: Some(60_000),
            }),
        };
        let json = serde_json::to_value(&params).unwrap();
        assert_eq!(json["target"], "agent-abc");
        assert_eq!(json["wait"]["until"][0], "blocked");
        assert_eq!(json["wait"]["timeout_ms"], 60_000u64);
    }

    #[test]
    fn agent_prompt_without_wait_omits_field() {
        let params = AgentPromptParams {
            target: "agent-abc".to_string(),
            text: "do the thing".to_string(),
            wait: None,
        };
        let json = serde_json::to_value(&params).unwrap();
        assert!(
            json.get("wait").is_none(),
            "wait field should be absent when None"
        );
    }

    #[test]
    fn pane_split_params_serializes() {
        let params = PaneSplitParams {
            direction: SplitDirection::Vertical,
            cwd: Some("/repo".to_string()),
            workspace_id: None,
            focus: false,
        };
        let json = serde_json::to_value(&params).unwrap();
        assert_eq!(json["direction"], "vertical");
        assert_eq!(json["cwd"], "/repo");
        assert!(json.get("workspace_id").is_none());
    }

    #[test]
    fn worktree_create_params_serializes() {
        let params = WorktreeCreateParams {
            branch: Some("feat/rv7".to_string()),
            path: None,
            cwd: Some("/repo".to_string()),
            label: Some("rv7-work".to_string()),
            focus: false,
        };
        let json = serde_json::to_value(&params).unwrap();
        assert_eq!(json["branch"], "feat/rv7");
        assert_eq!(json["cwd"], "/repo");
        assert_eq!(json["label"], "rv7-work");
        assert!(json.get("path").is_none());
    }

    #[test]
    fn response_error_deserializes() {
        let raw = r#"{"id":"req-1","error":{"code":"not_found","message":"pane not found"}}"#;
        let resp: Response = serde_json::from_str(raw).unwrap();
        assert!(resp.result.is_none());
        let err = resp.error.unwrap();
        assert_eq!(err.code, "not_found");
        assert_eq!(err.message, "pane not found");
    }

    #[test]
    fn response_result_deserializes() {
        let raw = r#"{"id":"req-2","result":{"pane_id":"pane-xyz"}}"#;
        let resp: Response = serde_json::from_str(raw).unwrap();
        assert!(resp.error.is_none());
        let result = resp.result.unwrap();
        assert_eq!(result["pane_id"], "pane-xyz");
    }

    #[tokio::test]
    async fn request_timeout_is_explicitly_ambiguous() {
        use tokio::net::UnixListener;

        // Unix-domain socket paths have a small platform limit; use /tmp rather
        // than the often much longer per-user temporary-directory prefix.
        let path = std::path::PathBuf::from("/tmp")
            .join(format!("bs-herdr-{}.sock", uuid::Uuid::new_v4()));
        let listener = UnixListener::bind(&path).unwrap();
        let server = tokio::spawn(async move {
            let _connection = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });

        let err = call_at_path_with_timeout(
            &path,
            "agent.start",
            serde_json::json!({}),
            std::time::Duration::from_millis(5),
        )
        .await
        .unwrap_err();
        assert!(err.contains("outcome is unknown"));
        assert!(err.contains("do not retry automatically"));

        server.abort();
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn is_available_false_without_env() {
        // Without HERDR_SOCKET_PATH pointing at a real socket, should be false.
        // (herdr may be running in CI; socket_path() can return Some but a
        // non-existent path. We only test the env-unset path here.)
        let orig = std::env::var("HERDR_SOCKET_PATH").ok();
        unsafe {
            std::env::remove_var("HERDR_SOCKET_PATH");
        }
        assert!(!is_available(), "should be false when env var absent");
        if let Some(v) = orig {
            unsafe {
                std::env::set_var("HERDR_SOCKET_PATH", v);
            }
        }
    }
}
