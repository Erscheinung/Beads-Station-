// Beads Station — Phase 2 multi-session claude stream-json bridge.
//
// Maintains a map of persistent `claude --print --verbose
// --input-format=stream-json --output-format=stream-json` subprocesses.
// (`--verbose` is mandatory: the Claude CLI requires it whenever `--print`
// is combined with `--output-format=stream-json`.) Each session's stdout is
// parsed line-by-line as stream-json frames and emitted to the UI via the
// namespaced Tauri event `claude_event:{project_id}`. Stderr is forwarded as
// `claude_stderr:{project_id}` and unparseable stdout lines as
// `claude_event_raw:{project_id}`.
//
// RV2 (multi-agent panes): the map key and event-namespace suffix named
// `project_id` throughout this file is now a BRIDGE ID — a pane-scoped
// identity. For the legacy single chat it equals the project id (byte-for-
// byte back-compat); each agent pane passes a distinct opaque string, so two
// panes targeting the SAME project get separate SESSIONS entries, separate
// child processes, and separate event streams. The Rust param name is kept
// as `project_id` deliberately (zero ABI change — the FE keeps passing the
// value in the existing `projectId` arg slot); only its meaning widened.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use tauri::{Emitter, Window};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

// Phase 2 still hardcodes the claude binary path. Phase 6 will make this
// configurable via settings. Phase 2.5 routes the literal through
// binresolve so we still find claude when it's been installed somewhere
// else (e.g. /opt/homebrew/bin) and only fall back to the literal when
// the resolver comes up empty.
const CLAUDE_BIN_FALLBACK: &str = "~/.local/bin/claude";

/// Build a colon-joined PATH that prepends the canonical install dirs to
/// whatever PATH the GUI app inherited. Deduped while preserving order so
/// child processes (claude itself, and anything claude shells out to like
/// git) can find their tools even when launchd handed us an empty PATH.
fn augmented_path() -> String {
    let canonical = ["~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"];
    let inherited = std::env::var("PATH").unwrap_or_default();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for entry in canonical.iter().map(|s| s.to_string()).chain(
        inherited.split(':').filter(|s| !s.is_empty()).map(|s| s.to_string()),
    ) {
        if seen.insert(entry.clone()) {
            out.push(entry);
        }
    }
    out.join(":")
}

struct ClaudeSession {
    // RV3.7 (Code-8vm) — stdin behind its own Arc<Mutex> so claude_send /
    // permission responses lock ONLY this bridge's pipe, not the global
    // SESSIONS map. A wedged/backpressured child stdin therefore can no longer
    // stall every other bridge's send/approve/deny behind the map lock.
    stdin: Arc<Mutex<ChildStdin>>,
    child: Child,
    session_id: String,
}

/// Per-bridge session map. Keyed by the bridge id (see the module doc —
/// == project id for the legacy chat, distinct per agent pane in RV2).
/// The lock is only held for the two O(1) map touches (idempotency check
/// and insert); it is deliberately NOT held across the child `.spawn()`
/// (see `claude_start` — the Code-urn fix), so concurrent starts of
/// distinct bridges proceed in parallel.
static SESSIONS: Lazy<Mutex<HashMap<String, ClaudeSession>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Per-bridge transient cache of the desired permission_mode. Read by
/// `claude_start` when (re)spawning a session; the FE persists the value
/// itself via tauri-plugin-store. This map is just so the FE can call
/// `claude_set_permission_mode` mid-session without forcing a session
/// restart — the next start picks the latest value up. (Keyed by bridge id
/// like SESSIONS. Agent panes typically pass an explicit permission_mode to
/// `claude_start` and bypass this map entirely.)
static MODES: Lazy<Mutex<HashMap<String, String>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Whitelist for the --permission-mode flag. Anything else is rejected at
/// the boundary so we don't pass garbage to claude.
fn validate_permission_mode(mode: &str) -> Result<(), String> {
    match mode {
        "acceptEdits" | "default" | "plan" => Ok(()),
        other => Err(format!(
            "invalid permission_mode \"{other}\" (expected acceptEdits, default, or plan)"
        )),
    }
}

#[tauri::command]
pub async fn claude_start(
    window: Window,
    project_id: String,
    cwd: String,
    session_id: String,
    permission_mode: Option<String>,
) -> Result<String, String> {
    // Code-urn fix: hold SESSIONS only for the O(1) idempotency check, then
    // DROP it before the child `.spawn()`. Holding the lock across the fork
    // serialized concurrent starts (two `<leader>a` spawns would block on one
    // mutex through a process fork). Scope the guard so it releases here.
    {
        let guard = SESSIONS.lock().await;
        if let Some(existing) = guard.get(&project_id) {
            return Ok(existing.session_id.clone());
        }
    }

    // Resolve permission_mode in priority order:
    //   1. Explicit arg from this call (FE just changed it).
    //   2. Cached value from a prior `claude_set_permission_mode` call.
    //   3. Default "acceptEdits" — historical behaviour pre-Phase 6.
    let mode = if let Some(m) = permission_mode {
        m
    } else {
        let modes = MODES.lock().await;
        modes
            .get(&project_id)
            .cloned()
            .unwrap_or_else(|| "acceptEdits".to_string())
    };
    validate_permission_mode(&mode)?;

    // Resolve claude binary via binresolve; fall back to the literal if the
    // resolver finds nothing. Also emit a diagnostic event so we can tell
    // from the frontend exactly which binary + cwd we're spawning under —
    // this is what made the Phase 2.5 dmg debugging trivial.
    let claude_path = crate::binresolve::resolve_bin_or_default("claude", CLAUDE_BIN_FALLBACK)
        .map_err(|e| format!("resolve claude binary: {e}"))?;
    let path_env = augmented_path();

    {
        let raw_event_name = format!("claude_event_raw:{project_id}");
        let api_key_present = std::env::var("ANTHROPIC_API_KEY")
            .map(|v| !v.is_empty())
            .unwrap_or(false);
        let base_url = std::env::var("ANTHROPIC_BASE_URL")
            .unwrap_or_else(|_| "<unset>".into());
        let msg = format!(
            "[claude_start] cwd={cwd} bin={} api_key_present={api_key_present} base_url={base_url} (PATH={path_env})",
            claude_path.display()
        );
        eprintln!("{msg}");
        let _ = window.emit(&raw_event_name, msg);
    }

    let mut cmd = Command::new(&claude_path);
    cmd.arg("--print")
        .arg("--verbose")
        .arg("--input-format=stream-json")
        .arg("--output-format=stream-json")
        .arg("--include-partial-messages")
        .arg("--include-hook-events")
        .arg("--session-id")
        .arg(&session_id)
        .arg("--permission-mode")
        .arg(&mode)
        .arg("--add-dir")
        .arg(&cwd)
        .current_dir(&cwd)
        .env("PATH", &path_env)
        // RV2-fix (Code-51e): kill the child if its ClaudeSession is ever
        // dropped without an explicit claude_kill. tokio Command orphans by
        // default, so a dropped-but-unkilled session used to leak a live
        // `claude --print` process for the app's lifetime. This is the
        // last-line safety net; the app-exit CloseRequested handler and the
        // legacy-chat unmount kill are the primary reapers.
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Phase 2.6: explicitly forward the Anthropic-auth env vars envloader
    // installed at startup. set_var should already make these visible to
    // the child via inherited env, but tokio Command in some configs scrubs
    // or overrides parts of the environment — re-asserting them via
    // Command::env() makes propagation deterministic. We only forward the
    // vars that are actually present so we don't clobber a child's view
    // with empty strings.
    for var in ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] {
        if let Ok(val) = std::env::var(var) {
            if !val.is_empty() {
                cmd.env(var, val);
            }
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn claude: {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "claude stdin not captured".to_string())?;
    let stdin = Arc::new(Mutex::new(stdin));
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
    //
    // Phase 6: also emit `claude_status:{project_id}` events with one of
    // {"running","awaiting-input","error","idle"} on assistant-frame
    // arrival ("running") and result-frame arrival ("awaiting-input").
    // The stderr reader emits "error". The "idle" state is the FE's
    // initial value before any frame arrives — we never explicitly emit
    // it from the BE side.
    {
        let win = window.clone();
        let pid = project_id.clone();
        tokio::spawn(async move {
            let event_name = format!("claude_event:{pid}");
            let raw_event_name = format!("claude_event_raw:{pid}");
            let status_event_name = format!("claude_status:{pid}");
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
                                // Phase 6: peek at top-level "type" and
                                // dispatch a status event BEFORE handing
                                // the value off to .emit() (which moves it).
                                if let Some(t) = value.get("type").and_then(Value::as_str) {
                                    match t {
                                        "assistant" => {
                                            let _ = win.emit(&status_event_name, "running");
                                        }
                                        "result" => {
                                            let _ = win.emit(&status_event_name, "awaiting-input");
                                        }
                                        _ => {}
                                    }
                                }
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
    // Phase 6: ALSO emit `claude_status:{project_id}` = "error" on every
    // non-empty stderr line so the FE tab dot can flip red without having
    // to listen for stderr separately.
    {
        let win = window.clone();
        let pid = project_id.clone();
        tokio::spawn(async move {
            let event_name = format!("claude_stderr:{pid}");
            let status_event_name = format!("claude_status:{pid}");
            let mut reader = BufReader::new(stderr).lines();
            loop {
                match reader.next_line().await {
                    Ok(Some(line)) => {
                        if !line.trim().is_empty() {
                            let _ = win.emit(&status_event_name, "error");
                        }
                        let _ = win.emit(&event_name, line);
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
        });
    }

    // Re-acquire SESSIONS to insert. Between the drop above and here, a
    // concurrent start for the SAME bridge id could have won the race (e.g. a
    // StrictMode double-mount or MorningConfirm remount reusing one bridge).
    // Re-check under the lock; if we lost, kill our now-redundant child and
    // return the winner's session id. Distinct bridges never collide here, so
    // this path is near-dead in RV2 — but it's mandatory to avoid leaking an
    // orphan claude subprocess on the same-bridge race.
    //
    // RV3.7 (Code-9wf) — do NOT reap the redundant child under the SESSIONS
    // lock: child.wait() can block on OS process teardown, and holding the
    // global map lock across it stalls every other bridge's start/send/kill
    // (the same class the Code-urn spawn fix addressed). On a lost race,
    // capture the winner's sid, DROP the guard, then kill/wait outside the
    // critical section.
    {
        let mut guard = SESSIONS.lock().await;
        if let Some(existing) = guard.get(&project_id) {
            let sid = existing.session_id.clone();
            drop(guard);
            let mut redundant = child;
            let _ = redundant.start_kill();
            let _ = redundant.wait().await;
            return Ok(sid);
        }
        guard.insert(
            project_id.clone(),
            ClaudeSession {
                stdin,
                child,
                session_id: session_id.clone(),
            },
        );
    }

    Ok(session_id)
}

#[tauri::command]
pub async fn claude_send(project_id: String, text: String) -> Result<(), String> {
    // RV3.7 (Code-8vm) — hold the SESSIONS lock only long enough to clone the
    // per-bridge stdin handle, then DROP it before the pipe write/flush. A
    // full/backpressured child stdin now blocks only this bridge, not every
    // other bridge's send/approve/deny.
    let stdin = {
        let guard = SESSIONS.lock().await;
        let session = guard
            .get(&project_id)
            .ok_or_else(|| format!("claude session not started for project {project_id}"))?;
        session.stdin.clone()
    };

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

    let mut stdin = stdin.lock().await;
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("write to claude stdin: {e}"))?;
    stdin
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

/// RV2-fix (Code-51e): reap EVERY live claude session at once. Drains the
/// SESSIONS map and kills each child. Invoked on window close (see lib.rs
/// on_window_event) so quitting the app never orphans a `claude --print`
/// child. Also callable from the FE as a panic button. Idempotent — a second
/// call finds an empty map and returns Ok. Returns the count reaped.
pub async fn kill_all_sessions() -> usize {
    let mut guard = SESSIONS.lock().await;
    let drained: Vec<ClaudeSession> = guard.drain().map(|(_, s)| s).collect();
    let n = drained.len();
    for mut session in drained {
        let _ = session.child.start_kill();
        let _ = session.child.wait().await;
    }
    n
}

#[tauri::command]
pub async fn claude_kill_all() -> Result<usize, String> {
    Ok(kill_all_sessions().await)
}

/// RV3.7 (Code-uu5) — reap any session whose bridge is no longer live in the
/// FE pane tree. Agent-pane ClaudeChat unmount deliberately does NOT
/// claude_kill (agent panes are persistent by design), and closeActivePane
/// only reports the ACTIVE leaf's bridge — so an agent leaf discarded from
/// state without being the active pane (e.g. a whole tab reset) leaks its
/// `claude --print` child until app exit, since kill_on_drop only fires when
/// the ClaudeSession is actually dropped (i.e. removed from SESSIONS). The FE
/// calls this with the set of bridge ids still present in the pane tree; any
/// SESSIONS entry NOT in that set is removed (dropped -> kill_on_drop) and
/// reaped. Returns the count reaped. Bridges the FE still owns are untouched.
#[tauri::command]
pub async fn claude_reconcile(live_bridges: Vec<String>) -> Result<usize, String> {
    let live: std::collections::HashSet<String> = live_bridges.into_iter().collect();
    let stale: Vec<ClaudeSession> = {
        let mut guard = SESSIONS.lock().await;
        let stale_keys: Vec<String> = guard
            .keys()
            .filter(|k| !live.contains(*k))
            .cloned()
            .collect();
        stale_keys
            .into_iter()
            .filter_map(|k| guard.remove(&k))
            .collect()
    };
    let n = stale.len();
    for mut session in stale {
        let _ = session.child.start_kill();
        let _ = session.child.wait().await;
    }
    Ok(n)
}

/// Phase 6 — set the per-project permission mode without restarting the
/// session. The cached value is consulted by `claude_start` on the next
/// (re)spawn. The FE persists the user-visible setting via
/// tauri-plugin-store and calls this command on every change.
#[tauri::command]
pub async fn claude_set_permission_mode(
    project_id: String,
    mode: String,
) -> Result<(), String> {
    validate_permission_mode(&mode)?;
    let mut modes = MODES.lock().await;
    modes.insert(project_id, mode);
    Ok(())
}

/// Frame shape for `claude_approve` / `claude_deny`.
///
/// As of Claude CLI 2.x (verified empirically against
/// `~/.local/bin/claude --help` 2026-06-18), there is no
/// documented `permission_request` / `permission_response` stream-json
/// pair in `--input-format=stream-json`. The CLI's `--permission-mode`
/// values are {bypassPermissions, default, plan, acceptEdits}; the
/// "default" mode prompts interactively at the terminal, not via a JSON
/// frame round-trip.
///
/// Until upstream exposes a real permission-response frame, we use the
/// canonical tool_result shape — a user-role frame with a tool_result
/// content block whose `tool_use_id` echoes the request_id and whose
/// `content` is the literal string "approved" or "denied". This matches
/// the convention used in the Anthropic Messages API for any tool-use
/// continuation flow and is the safest forward-compatible default.
///
/// If the CLI ignores these frames (because it doesn't expose
/// permission_request), the FE's approval card still collapses to its
/// resolved state and the parent transcript is unaffected. When upstream
/// adds a real permission_response shape, swap this fn body to emit it
/// — the FE contract (claude_approve / claude_deny commands) does not
/// change.
async fn write_permission_response(
    project_id: &str,
    request_id: &str,
    decision: &'static str, // "approved" or "denied"
) -> Result<(), String> {
    // RV3.7 (Code-8vm) — clone the per-bridge stdin under the map lock, drop
    // it, then write/flush. Approvals no longer serialize behind a wedged
    // sibling child's stdin.
    let stdin = {
        let guard = SESSIONS.lock().await;
        let session = guard
            .get(project_id)
            .ok_or_else(|| format!("claude session not started for project {project_id}"))?;
        session.stdin.clone()
    };

    let frame = json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": request_id,
                    "content": decision,
                }
            ]
        }
    });

    let mut line = serde_json::to_string(&frame)
        .map_err(|e| format!("serialize permission frame: {e}"))?;
    line.push('\n');

    let mut stdin = stdin.lock().await;
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("write permission frame to claude stdin: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("flush permission frame: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn claude_approve(project_id: String, request_id: String) -> Result<(), String> {
    write_permission_response(&project_id, &request_id, "approved").await
}

#[tauri::command]
pub async fn claude_deny(project_id: String, request_id: String) -> Result<(), String> {
    write_permission_response(&project_id, &request_id, "denied").await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_mode_whitelist() {
        assert!(validate_permission_mode("plan").is_ok());
        assert!(validate_permission_mode("acceptEdits").is_ok());
        assert!(validate_permission_mode("default").is_ok());
        // bypassPermissions is a valid CLI flag but intentionally NOT allowed
        // through this boundary.
        assert!(validate_permission_mode("bypassPermissions").is_err());
        assert!(validate_permission_mode("garbage").is_err());
    }

    // RV2 compound-key contract: MODES is keyed by BRIDGE id, not project id.
    // Two bridges that happen to share a project prefix must occupy separate
    // entries — this proves two agent panes on the SAME project don't collide.
    // (SESSIONS holds real child procs so it isn't unit-testable without a
    // fake binary; MODES is the honest deterministic proxy for the keying.)
    #[tokio::test]
    async fn distinct_bridge_ids_do_not_collide() {
        claude_set_permission_mode("proj#a".into(), "plan".into())
            .await
            .unwrap();
        claude_set_permission_mode("proj#b".into(), "acceptEdits".into())
            .await
            .unwrap();
        let m = MODES.lock().await;
        assert_eq!(m.get("proj#a").map(String::as_str), Some("plan"));
        assert_eq!(m.get("proj#b").map(String::as_str), Some("acceptEdits"));
    }

    // Legacy path: bridge id == project id keys its own entry (back-compat).
    // (Asserts only its own key, not global len — MODES is a process-global
    // shared with the sibling test, which may run concurrently.)
    #[tokio::test]
    async fn legacy_bridge_equals_project_keys_one_entry() {
        claude_set_permission_mode("projX-legacy".into(), "default".into())
            .await
            .unwrap();
        let m = MODES.lock().await;
        assert_eq!(m.get("projX-legacy").map(String::as_str), Some("default"));
    }

    // RV2-fix (Code-51e): kill_all drains SESSIONS. Can't insert a real
    // ClaudeSession without spawning claude (Child has no safe fake), so this
    // asserts the honest headless-testable slice: on an empty/drained map the
    // reaper returns 0 and is idempotent (never panics, never blocks). The
    // real kill is exercised by the tokio Child in the running app + the
    // CloseRequested handler; kill_on_drop is the type-level safety net.
    #[tokio::test]
    async fn kill_all_on_empty_is_zero_and_idempotent() {
        // Ensure a clean slate w.r.t. this contract (other tests never insert
        // into SESSIONS — only MODES — so this map is empty in the test bin).
        let first = kill_all_sessions().await;
        let second = kill_all_sessions().await;
        assert_eq!(first, 0);
        assert_eq!(second, 0);
        let guard = SESSIONS.lock().await;
        assert!(guard.is_empty());
    }
}
