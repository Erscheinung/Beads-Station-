//! Codex's provider-neutral interactive chat adapter.
//!
//! The Codex TUI is not a suitable child for the React chat input. Codex's
//! supported local `app-server` protocol provides the same persistent,
//! multi-turn boundary as Claude's stream-json bridge: initialize once, start
//! a thread without a model turn, and send later turns with `turn/start`.
//! Authentication remains owned by the Codex CLI. This module never reads or
//! logs credentials and provider discovery stays in `native_provider_status`.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use tauri::{Emitter, Window};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

const SCROLLBACK_CAP: usize = 64;
// This is the app-server wire value. It is intentionally not Rust-style
// `readOnly`: the server deserializes this field as a kebab-case enum.
const CODEX_DEFAULT_SANDBOX: &str = "read-only";
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

struct CodexSession {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Child,
    thread_id: String,
    _permit: tokio::sync::OwnedSemaphorePermit,
}

static SESSIONS: Lazy<Mutex<HashMap<String, CodexSession>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static SCROLLBACK: Lazy<Mutex<HashMap<String, Vec<Value>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn request_id() -> u64 {
    NEXT_REQUEST_ID.fetch_add(1, Ordering::SeqCst)
}

fn rpc_request(id: u64, method: &str, params: Value) -> Value {
    // Codex app-server speaks JSON-RPC-shaped JSONL, but intentionally omits
    // the jsonrpc version field on the wire.
    json!({ "id": id, "method": method, "params": params })
}

fn thread_start_request(id: u64, cwd: &str) -> Value {
    rpc_request(
        id,
        "thread/start",
        json!({
            "cwd": cwd,
            "approvalPolicy": "never",
            "sandbox": CODEX_DEFAULT_SANDBOX,
            "serviceName": "beads_station_interactive_chat",
        }),
    )
}

async fn write_json(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    let mut line =
        serde_json::to_vec(value).map_err(|e| format!("serialize Codex request: {e}"))?;
    line.push(b'\n');
    stdin
        .write_all(&line)
        .await
        .map_err(|e| format!("write Codex request: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("flush Codex request: {e}"))
}

async fn write_shared(stdin: &Arc<Mutex<ChildStdin>>, value: &Value) -> Result<(), String> {
    let mut guard = stdin.lock().await;
    write_json(&mut guard, value).await
}

fn rpc_response_result(response: Value, id: u64) -> Result<Value, String> {
    if response.get("id").and_then(Value::as_u64) != Some(id) {
        return Err(format!(
            "Codex returned a response for an unexpected request ({id})"
        ));
    }
    if let Some(error) = response.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown Codex app-server error");
        return Err(message.to_string());
    }
    response
        .get("result")
        .cloned()
        .ok_or_else(|| format!("Codex response {id} had no result"))
}

async fn read_response(reader: &mut BufReader<ChildStdout>, id: u64) -> Result<Value, String> {
    loop {
        let mut line = String::new();
        let read = reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("read Codex response: {e}"))?;
        if read == 0 {
            return Err("Codex app-server closed during startup".into());
        }
        let value: Value =
            serde_json::from_str(line.trim()).map_err(|e| format!("parse Codex response: {e}"))?;
        // Startup can publish a notification before a request response. It is
        // intentionally ignored here; the persistent reader is attached only
        // after the thread has been created and identified.
        if value.get("id").and_then(Value::as_u64) == Some(id) {
            return rpc_response_result(value, id);
        }
    }
}

fn thread_id_from(result: &Value) -> Result<String, String> {
    result
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(String::from)
        .ok_or_else(|| "Codex thread/start returned no thread id".into())
}

fn event_frame(value: &Value) -> Option<(Value, Option<&'static str>)> {
    let method = value.get("method").and_then(Value::as_str)?;
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    match method {
        "turn/started" => Some((Value::Null, Some("running"))),
        "turn/completed" => {
            let subtype = params
                .pointer("/turn/status")
                .and_then(Value::as_str)
                .unwrap_or("completed");
            Some((
                json!({ "type": "result", "subtype": subtype }),
                Some("awaiting-input"),
            ))
        }
        "item/agentMessage/delta" => {
            let delta = params
                .get("delta")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if delta.is_empty() {
                None
            } else {
                Some((
                    json!({
                        "type": "assistant",
                        "message": { "role": "assistant", "content": [{ "type": "text", "text": delta }] },
                    }),
                    Some("running"),
                ))
            }
        }
        "item/plan/delta" => {
            let delta = params
                .get("delta")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if delta.is_empty() {
                None
            } else {
                Some((
                    json!({
                        "type": "assistant",
                        "message": { "role": "assistant", "content": [{ "type": "text", "text": delta }] },
                    }),
                    Some("running"),
                ))
            }
        }
        "command/exec/outputDelta" | "item/commandExecution/outputDelta" => {
            let delta = params
                .get("delta")
                .or_else(|| params.get("outputDelta"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if delta.is_empty() {
                None
            } else {
                Some((json!({ "_kind": "raw", "line": delta }), None))
            }
        }
        "error" => {
            let message = params
                .get("message")
                .and_then(Value::as_str)
                .map(String::from)
                .unwrap_or_else(|| params.to_string());
            Some((json!({ "_kind": "stderr", "line": message }), Some("error")))
        }
        _ => None,
    }
}

async fn record_event(project_id: &str, event: Value, window: &Window) {
    let mut scrollback = SCROLLBACK.lock().await;
    let ring = scrollback.entry(project_id.to_string()).or_default();
    if ring.len() >= SCROLLBACK_CAP {
        ring.remove(0);
    }
    ring.push(event.clone());
    drop(scrollback);
    let _ = window.emit(
        &format!("codex_event:{}", crate::claude::chan_id(project_id)),
        event,
    );
}

async fn read_stdout(
    project_id: String,
    thread_id: String,
    window: Window,
    mut reader: BufReader<ChildStdout>,
) {
    loop {
        let mut line = String::new();
        let result = reader.read_line(&mut line).await;
        let Ok(read) = result else { break };
        if read == 0 {
            let _ = window.emit(
                &format!("codex_status:{}", crate::claude::chan_id(&project_id)),
                "exited",
            );
            let mut sessions = SESSIONS.lock().await;
            if sessions
                .get(&project_id)
                .map(|session| session.thread_id == thread_id)
                .unwrap_or(false)
            {
                sessions.remove(&project_id);
            }
            break;
        }
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            record_event(
                &project_id,
                json!({ "_kind": "raw", "line": line.trim() }),
                &window,
            )
            .await;
            continue;
        };
        let Some((event, status)) = event_frame(&value) else {
            continue;
        };
        if !event.is_null() {
            record_event(&project_id, event, &window).await;
        }
        if let Some(status) = status {
            let _ = window.emit(
                &format!("codex_status:{}", crate::claude::chan_id(&project_id)),
                status,
            );
        }
    }
}

async fn read_stderr(project_id: String, window: Window, mut reader: BufReader<ChildStderr>) {
    loop {
        let mut line = String::new();
        let Ok(read) = reader.read_line(&mut line).await else {
            break;
        };
        if read == 0 {
            break;
        }
        if !line.trim().is_empty() {
            let _ = window.emit(
                &format!("codex_status:{}", crate::claude::chan_id(&project_id)),
                "error",
            );
            let _ = window.emit(
                &format!("codex_stderr:{}", crate::claude::chan_id(&project_id)),
                line.trim_end().to_string(),
            );
        }
    }
}

#[tauri::command]
pub async fn codex_chat_start(
    window: Window,
    project_id: String,
    cwd: String,
) -> Result<String, String> {
    if project_id.trim().is_empty() || cwd.trim().is_empty() {
        return Err("project_id and cwd are required".into());
    }

    {
        let mut sessions = SESSIONS.lock().await;
        if let Some(existing) = sessions.get_mut(&project_id) {
            match existing.child.try_wait() {
                Ok(Some(_)) => {
                    sessions.remove(&project_id);
                }
                Ok(None) | Err(_) => return Ok(existing.thread_id.clone()),
            }
        }
    }

    let binary = crate::binresolve::resolve_bin("codex")
        .map_err(|e| format!("resolve codex binary: {e}"))?;
    let permit = crate::spawngov::agent_permit()?;
    let mut child = Command::new(binary)
        .arg("app-server")
        .arg("--listen")
        .arg("stdio://")
        .current_dir(&cwd)
        .env("PATH", crate::claude::augmented_path())
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start Codex app-server: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("Codex stdin not captured")?;
    let stdout = child.stdout.take().ok_or("Codex stdout not captured")?;
    let stderr = child.stderr.take().ok_or("Codex stderr not captured")?;
    let mut reader = BufReader::new(stdout);

    let initialize_id = request_id();
    write_json(
        &mut stdin,
        &rpc_request(
            initialize_id,
            "initialize",
            json!({
                "clientInfo": { "name": "beads-station", "title": "Beads Station", "version": env!("CARGO_PKG_VERSION") },
            }),
        ),
    )
    .await?;
    let _ = read_response(&mut reader, initialize_id).await?;
    write_json(
        &mut stdin,
        &json!({ "method": "initialized", "params": {} }),
    )
    .await?;

    // thread/start creates only the local app-server thread. No model turn is
    // requested until the user submits text through codex_chat_send.
    let start_id = request_id();
    write_json(&mut stdin, &thread_start_request(start_id, &cwd)).await?;
    let thread_id = thread_id_from(&read_response(&mut reader, start_id).await?)?;
    let stdin = Arc::new(Mutex::new(stdin));

    let mut sessions = SESSIONS.lock().await;
    if let Some(existing) = sessions.get(&project_id) {
        let winner = existing.thread_id.clone();
        drop(sessions);
        drop(permit);
        let mut redundant = child;
        let _ = redundant.start_kill();
        let _ = redundant.wait().await;
        return Ok(winner);
    }
    sessions.insert(
        project_id.clone(),
        CodexSession {
            stdin: stdin.clone(),
            child,
            thread_id: thread_id.clone(),
            _permit: permit,
        },
    );
    drop(sessions);

    let _ = window.emit(
        &format!("codex_status:{}", crate::claude::chan_id(&project_id)),
        "awaiting-input",
    );
    tokio::spawn(read_stdout(
        project_id.clone(),
        thread_id.clone(),
        window.clone(),
        reader,
    ));
    tokio::spawn(read_stderr(
        project_id.clone(),
        window,
        BufReader::new(stderr),
    ));
    Ok(thread_id)
}

#[tauri::command]
pub async fn codex_chat_send(project_id: String, text: String) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    let (stdin, thread_id) = {
        let sessions = SESSIONS.lock().await;
        let session = sessions
            .get(&project_id)
            .ok_or_else(|| format!("Codex chat session not started for project {project_id}"))?;
        (session.stdin.clone(), session.thread_id.clone())
    };
    let id = request_id();
    let request = rpc_request(
        id,
        "turn/start",
        json!({
            "threadId": thread_id,
            "input": [{ "type": "text", "text": text, "text_elements": [] }],
        }),
    );
    if let Err(error) = write_shared(&stdin, &request).await {
        let mut sessions = SESSIONS.lock().await;
        if sessions.get(&project_id).map(|s| s.thread_id.as_str()) == Some(thread_id.as_str()) {
            sessions.remove(&project_id);
        }
        return Err(format!("Codex chat session dead: {error}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn codex_chat_kill(project_id: String) -> Result<(), String> {
    let session = SESSIONS.lock().await.remove(&project_id);
    SCROLLBACK.lock().await.remove(&project_id);
    if let Some(mut session) = session {
        let _ = session.child.start_kill();
        let _ = session.child.wait().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn codex_chat_get_scrollback(project_id: String) -> Result<Vec<Value>, String> {
    Ok(SCROLLBACK
        .lock()
        .await
        .get(&project_id)
        .cloned()
        .unwrap_or_default())
}

#[tauri::command]
pub async fn codex_chat_get_session_id(project_id: String) -> Result<Option<String>, String> {
    Ok(SESSIONS
        .lock()
        .await
        .get(&project_id)
        .map(|session| session.thread_id.clone()))
}

#[tauri::command]
pub async fn codex_chat_reconcile(live_bridges: Vec<String>) -> Result<usize, String> {
    let live: std::collections::HashSet<String> = live_bridges.into_iter().collect();
    let stale: Vec<(String, CodexSession)> = {
        let mut sessions = SESSIONS.lock().await;
        let keys: Vec<String> = sessions
            .keys()
            .filter(|key| !live.contains(*key))
            .cloned()
            .collect();
        keys.into_iter()
            .filter_map(|key| sessions.remove(&key).map(|session| (key, session)))
            .collect()
    };
    let count = stale.len();
    for (key, mut session) in stale {
        SCROLLBACK.lock().await.remove(&key);
        let _ = session.child.start_kill();
        let _ = session.child.wait().await;
    }
    Ok(count)
}

pub async fn kill_all_codex_sessions() -> usize {
    let sessions: Vec<CodexSession> = SESSIONS
        .lock()
        .await
        .drain()
        .map(|(_, session)| session)
        .collect();
    let count = sessions.len();
    SCROLLBACK.lock().await.clear();
    for mut session in sessions {
        let _ = session.child.start_kill();
        let _ = session.child.wait().await;
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turn_request_uses_codex_app_server_shape() {
        let request = rpc_request(
            7,
            "turn/start",
            json!({ "threadId": "thread-1", "input": [{ "type": "text", "text": "hello", "text_elements": [] }] }),
        );
        assert_eq!(request["method"], "turn/start");
        assert!(request.get("jsonrpc").is_none());
        assert_eq!(request["params"]["threadId"], "thread-1");
        assert_eq!(request["params"]["input"][0]["type"], "text");
    }

    #[test]
    fn thread_start_serializes_the_read_only_wire_policy() {
        let request = thread_start_request(8, "/tmp/project");
        let encoded = serde_json::to_string(&request).unwrap();

        assert_eq!(request["method"], "thread/start");
        assert_eq!(request["params"]["sandbox"], "read-only");
        assert!(encoded.contains("\"sandbox\":\"read-only\""));
        assert!(!encoded.contains("readOnly"));
    }

    #[test]
    fn rejected_start_response_is_returned_without_fabricating_a_thread() {
        let response = json!({
            "id": 8,
            "error": {
                "code": -32602,
                "message": "Invalid params: unknown variant `readOnly`"
            }
        });

        let error = rpc_response_result(response, 8).unwrap_err();
        assert_eq!(error, "Invalid params: unknown variant `readOnly`");
        assert!(thread_id_from(&json!({})).is_err());
    }

    #[test]
    fn codex_deltas_are_adapted_to_existing_chat_frames() {
        let value = json!({ "method": "item/agentMessage/delta", "params": { "delta": "hello" } });
        let (frame, status) = event_frame(&value).unwrap();
        assert_eq!(status, Some("running"));
        assert_eq!(frame["type"], "assistant");
        assert_eq!(frame["message"]["content"][0]["text"], "hello");
    }

    #[test]
    fn non_text_codex_notifications_do_not_become_fake_messages() {
        let value = json!({ "method": "thread/status/changed", "params": {} });
        assert!(event_frame(&value).is_none());
    }
}
