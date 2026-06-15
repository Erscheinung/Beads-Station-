// Beads Station — Phase 2 multi-session claude stream-json bridge.
//
// Maintains a per-project map of persistent `claude --print
// --input-format=stream-json --output-format=stream-json` subprocesses,
// keyed by project id. Each session's stdout is parsed line-by-line as
// stream-json frames and emitted to the UI via the namespaced Tauri event
// `claude_event:{project_id}`. Stderr is forwarded as
// `claude_stderr:{project_id}` and unparseable stdout lines as
// `claude_event_raw:{project_id}`.

use std::collections::HashMap;
use std::process::Stdio;

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use tauri::{Emitter, Window};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

// Phase 2 still hardcodes the claude binary path. Phase 6 will make this
// configurable via settings.
const CLAUDE_BIN: &str = "~/.local/bin/claude";

struct ClaudeSession {
    stdin: ChildStdin,
    child: Child,
    session_id: String,
}

/// Per-project session map. Outer Mutex is tokio so we can hold it across
/// .await points (spawning the child, taking pipes); the inner HashMap is
/// std because all map mutation happens while the lock is held.
static SESSIONS: Lazy<Mutex<HashMap<String, ClaudeSession>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[tauri::command]
pub async fn claude_start(
    window: Window,
    project_id: String,
    cwd: String,
    session_id: String,
) -> Result<String, String> {
    let mut guard = SESSIONS.lock().await;

    // Idempotent: if a session for this project already exists, return its id.
    if let Some(existing) = guard.get(&project_id) {
        return Ok(existing.session_id.clone());
    }

    let mut cmd = Command::new(CLAUDE_BIN);
    cmd.arg("--print")
        .arg("--input-format=stream-json")
        .arg("--output-format=stream-json")
        .arg("--include-partial-messages")
        .arg("--include-hook-events")
        .arg("--session-id")
        .arg(&session_id)
        .arg("--permission-mode")
        .arg("acceptEdits")
        .arg("--add-dir")
        .arg(&cwd)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn claude: {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "claude stdin not captured".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "claude stdout not captured".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "claude stderr not captured".to_string())?;

    // stdout reader: parse line-by-line as JSON, emit
    // `claude_event:{project_id}`. Capture project_id by clone so the
    // event-name format string resolves correctly after the lock drops.
    {
        let win = window.clone();
        let pid = project_id.clone();
        tokio::spawn(async move {
            let event_name = format!("claude_event:{pid}");
            let raw_event_name = format!("claude_event_raw:{pid}");
            let mut reader = BufReader::new(stdout).lines();
            loop {
                match reader.next_line().await {
                    Ok(Some(line)) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Value>(trimmed) {
                            Ok(value) => {
                                let _ = win.emit(&event_name, value);
                            }
                            Err(_) => {
                                // Surface unparseable lines for diagnostics
                                // instead of silently dropping them.
                                let _ = win.emit(&raw_event_name, trimmed.to_string());
                            }
                        }
                    }
                    Ok(None) => break, // EOF
                    Err(e) => {
                        let _ = win.emit(&raw_event_name, format!("[stdout read error] {e}"));
                        break;
                    }
                }
            }
        });
    }

    // stderr reader: forward each line as `claude_stderr:{project_id}`.
    {
        let win = window.clone();
        let pid = project_id.clone();
        tokio::spawn(async move {
            let event_name = format!("claude_stderr:{pid}");
            let mut reader = BufReader::new(stderr).lines();
            loop {
                match reader.next_line().await {
                    Ok(Some(line)) => {
                        let _ = win.emit(&event_name, line);
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
        });
    }

    guard.insert(
        project_id.clone(),
        ClaudeSession {
            stdin,
            child,
            session_id: session_id.clone(),
        },
    );

    Ok(session_id)
}

#[tauri::command]
pub async fn claude_send(project_id: String, text: String) -> Result<(), String> {
    let mut guard = SESSIONS.lock().await;
    let session = guard
        .get_mut(&project_id)
        .ok_or_else(|| format!("claude session not started for project {project_id}"))?;

    let frame = json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [
                { "type": "text", "text": text }
            ]
        }
    });

    let mut line = serde_json::to_string(&frame)
        .map_err(|e| format!("serialize user frame: {e}"))?;
    line.push('\n');

    session
        .stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("write to claude stdin: {e}"))?;
    session
        .stdin
        .flush()
        .await
        .map_err(|e| format!("flush claude stdin: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn claude_kill(project_id: String) -> Result<(), String> {
    let mut guard = SESSIONS.lock().await;
    if let Some(mut session) = guard.remove(&project_id) {
        let _ = session.child.start_kill();
        let _ = session.child.wait().await;
    }
    Ok(())
}
