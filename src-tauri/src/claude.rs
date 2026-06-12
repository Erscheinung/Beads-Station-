// Beads Station — Phase 1 claude stream-json bridge.
//
// Spawns a single persistent `claude --print --input-format=stream-json
// --output-format=stream-json` subprocess hardcoded against
// ~/Code/sample-project. Stdout is parsed line-by-line as
// stream-json frames and emitted to the UI via the "claude_event" Tauri
// event. Stderr is forwarded as "claude_stderr".

use std::process::Stdio;
use std::sync::OnceLock;

use serde_json::{json, Value};
use tauri::{Emitter, Window};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

// Phase 1 only: hardcoded path resolved at agent build time via `which claude`.
// Phase 2 will make this configurable.
const CLAUDE_BIN: &str = "~/.local/bin/claude";
const PROJECT_DIR: &str = "~/Code/sample-project";
const PHASE1_SESSION_ID: &str = "00000000-0000-4000-8000-beadsphase01";

struct ClaudeSession {
    stdin: ChildStdin,
    child: Child,
    session_id: String,
}

fn session_slot() -> &'static Mutex<Option<ClaudeSession>> {
    static SLOT: OnceLock<Mutex<Option<ClaudeSession>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
pub async fn claude_start(window: Window) -> Result<String, String> {
    let mut guard = session_slot().lock().await;

    // Idempotent: if a session is already alive, return its id.
    if let Some(existing) = guard.as_ref() {
        return Ok(existing.session_id.clone());
    }

    let mut cmd = Command::new(CLAUDE_BIN);
    cmd.arg("--print")
        .arg("--input-format=stream-json")
        .arg("--output-format=stream-json")
        .arg("--include-partial-messages")
        .arg("--include-hook-events")
        .arg("--session-id")
        .arg(PHASE1_SESSION_ID)
        .arg("--permission-mode")
        .arg("acceptEdits")
        .arg("--add-dir")
        .arg(PROJECT_DIR)
        .current_dir(PROJECT_DIR)
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

    // stdout reader: parse line-by-line as JSON, emit "claude_event".
    {
        let win = window.clone();
        tokio::spawn(async move {
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
                                let _ = win.emit("claude_event", value);
                            }
                            Err(_) => {
                                // Surface unparseable lines for diagnostics
                                // instead of silently dropping them.
                                let _ = win.emit("claude_event_raw", trimmed.to_string());
                            }
                        }
                    }
                    Ok(None) => break, // EOF
                    Err(e) => {
                        let _ = win.emit(
                            "claude_event_raw",
                            format!("[stdout read error] {e}"),
                        );
                        break;
                    }
                }
            }
        });
    }

    // stderr reader: forward each line as "claude_stderr".
    {
        let win = window.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            loop {
                match reader.next_line().await {
                    Ok(Some(line)) => {
                        let _ = win.emit("claude_stderr", line);
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
        });
    }

    *guard = Some(ClaudeSession {
        stdin,
        child,
        session_id: PHASE1_SESSION_ID.to_string(),
    });

    Ok(PHASE1_SESSION_ID.to_string())
}

#[tauri::command]
pub async fn claude_send(text: String) -> Result<(), String> {
    let mut guard = session_slot().lock().await;
    let session = guard
        .as_mut()
        .ok_or_else(|| "claude session not started".to_string())?;

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
pub async fn claude_kill() -> Result<(), String> {
    let mut guard = session_slot().lock().await;
    if let Some(mut session) = guard.take() {
        let _ = session.child.start_kill();
        let _ = session.child.wait().await;
    }
    Ok(())
}
