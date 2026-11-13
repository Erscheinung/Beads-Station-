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
use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::Arc;

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use tauri::{Emitter, Window};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

const SCROLLBACK_CAP: usize = 64;

/// Code-6w0: Tauri event names may only contain alphanumerics, `-`, `/`, `:`,
/// `_`. Project ids are directory basenames (projects.rs), so a repo like
/// `All Doors` yields a space that makes every `listen()`/`emit()` for its
/// channels fail silently — the chat pane then renders zero frames. Sanitize
/// the id ONLY where it becomes an event-channel string; the SESSIONS /
/// SCROLLBACK map keys and command args keep the raw id. The FE has an
/// identical `chanId` (src/lib/eventChannel.ts) so both sides agree.
pub(crate) fn chan_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Per-bridge scrollback ring buffer. Stores the last SCROLLBACK_CAP parsed
/// JSON frames so a late-mounting or re-mounting listener can replay them via
/// claude_get_scrollback without losing the session preamble (Code-lbi).
static SCROLLBACK: Lazy<Mutex<HashMap<String, VecDeque<Value>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Build a colon-joined PATH that prepends the canonical install dirs to
/// whatever PATH the GUI app inherited. Deduped while preserving order so
/// child processes (claude itself, and anything claude shells out to like
/// git) can find their tools even when launchd handed us an empty PATH.
pub(crate) fn augmented_path() -> String {
    let canonical = ["/opt/homebrew/bin", "/usr/local/bin"];
    let inherited = std::env::var("PATH").unwrap_or_default();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    // HOME-expanded ~/.local/bin first (was a hardcoded per-user .local/bin —
    // dead on any other machine / packaged .app). nvm node bin dirs next: an
    // nvm-managed claude/node/git-helpers won't be on the GUI app's launchd PATH
    // otherwise (same gap binresolve closes).
    let home_local: Vec<String> = crate::binresolve::expand_home("~/.local/bin")
        .and_then(|p| p.to_str().map(String::from))
        .into_iter()
        .collect();
    let nvm_dirs: Vec<String> = crate::binresolve::nvm_node_bin_dirs()
        .into_iter()
        .filter_map(|p| p.to_str().map(String::from))
        .collect();
    for entry in home_local
        .into_iter()
        .chain(nvm_dirs.into_iter())
        .chain(canonical.iter().map(|s| s.to_string()))
        .chain(inherited.split(':').filter(|s| !s.is_empty()).map(|s| s.to_string()))
    {
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
    // EXP backbone: the spawn-governor permit for this child. A `claude --print`
    // is long-lived (holds three pipe fds for its whole life), so unlike a
    // short bd read it must keep its permit until the child is reaped. Held here
    // so it drops exactly when the ClaudeSession leaves the SESSIONS map (every
    // removal = reap: normal exit, claude_kill, kill_all_sessions, reconcile).
    _permit: tokio::sync::OwnedSemaphorePermit,
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

/// Short-lived, ticket-bound provider runs used by the designer surface. These
/// deliberately use each installed CLI's supported non-interactive JSONL mode;
/// authentication remains owned by the CLI and no credentials enter the app.
struct NativeRun {
    child: Option<Child>,
    workspace_id: String,
    ticket_id: String,
    attempt_id: String,
    cwd: String,
    provider: String,
    events: VecDeque<Value>,
    next_seq: u64,
    drained: bool,
    cancel_requested: bool,
    unknown: bool,
    _permit: tokio::sync::OwnedSemaphorePermit,
}

static NATIVE_RUNS: Lazy<Mutex<HashMap<String, NativeRun>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static NATIVE_TERMINALS: Lazy<Mutex<VecDeque<NativeRunSnapshot>>> =
    Lazy::new(|| Mutex::new(VecDeque::new()));
static NATIVE_REVIEW_ACTIONS: Lazy<Arc<Mutex<()>>> =
    Lazy::new(|| Arc::new(Mutex::new(())));

pub(crate) async fn lock_native_review_action() -> tokio::sync::OwnedMutexGuard<()> {
    NATIVE_REVIEW_ACTIONS.clone().lock_owned().await
}

fn native_ticket_is_reserved(runs: &HashMap<String, NativeRun>, workspace_id: &str, ticket_id: &str) -> bool {
    runs.values().any(|run| run.workspace_id == workspace_id && run.ticket_id == ticket_id)
}

const NATIVE_RUN_SCROLLBACK_CAP: usize = 200;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRunSnapshot {
    run_id: String,
    workspace_id: String,
    ticket_id: String,
    attempt_id: String,
    cwd: String,
    provider: String,
    status: String,
    events: Vec<Value>,
}

async fn record_native_event(run_id: &str, mut event: Value) -> Option<Value> {
    let mut runs = NATIVE_RUNS.lock().await;
    let run = runs.get_mut(run_id)?;
    let seq = run.next_seq;
    run.next_seq += 1;
    if let Some(object) = event.as_object_mut() {
        object.insert("seq".into(), json!(seq));
    }
    if run.events.len() >= NATIVE_RUN_SCROLLBACK_CAP {
        run.events.pop_front();
    }
    run.events.push_back(event.clone());
    Some(event)
}

async fn emit_native_event(window: &Window, run_id: &str, event: Value) {
    if let Some(event) = record_native_event(run_id, event).await {
        let channel = format!("native_run_event:{}", chan_id(run_id));
        let _ = window.emit(&channel, event);
    }
}

async fn retain_native_terminal(runs: &mut HashMap<String, NativeRun>, run_id: &str, status: &str) -> Result<Value, String> {
    // Lock order matches native_run_snapshot. Moving active -> terminal while
    // both are held prevents reload from observing a gap between registries.
    let mut terminals = NATIVE_TERMINALS.lock().await;
    let mut run = runs.remove(run_id).ok_or_else(|| format!("run {run_id} ownership was lost"))?;
    let event = json!({ "kind": "status", "status": status, "seq": run.next_seq });
    if run.events.len() >= NATIVE_RUN_SCROLLBACK_CAP { run.events.pop_front(); }
    run.events.push_back(event.clone());
    let snapshot = NativeRunSnapshot {
        run_id: run_id.to_string(),
        workspace_id: run.workspace_id,
        ticket_id: run.ticket_id,
        attempt_id: run.attempt_id,
        cwd: run.cwd,
        provider: run.provider,
        status: status.into(),
        events: run.events.into_iter().collect(),
    };
    terminals.retain(|old| !(old.workspace_id == snapshot.workspace_id && old.ticket_id == snapshot.ticket_id));
    if terminals.len() >= 50 { terminals.pop_front(); }
    terminals.push_back(snapshot);
    Ok(event)
}

#[tauri::command]
pub async fn native_run_snapshot(workspace_id: String) -> Result<Vec<NativeRunSnapshot>, String> {
    let mut runs = NATIVE_RUNS.lock().await;
    let terminals = NATIVE_TERMINALS.lock().await;
    let mut by_ticket: HashMap<String, NativeRunSnapshot> = terminals
        .iter()
        .filter(|run| run.workspace_id == workspace_id)
        .cloned()
        .map(|run| (run.ticket_id.clone(), run))
        .collect();
    let ids: Vec<String> = runs.keys().cloned().collect();
    for run_id in ids {
        let Some(run) = runs.get_mut(&run_id) else { continue };
        let status = if run.unknown { "unknown" } else { "running" };
        if run.workspace_id == workspace_id {
            by_ticket.insert(run.ticket_id.clone(), NativeRunSnapshot {
                run_id,
                workspace_id: run.workspace_id.clone(),
                ticket_id: run.ticket_id.clone(),
                attempt_id: run.attempt_id.clone(),
                cwd: run.cwd.clone(),
                provider: run.provider.clone(),
                status: status.into(),
                events: run.events.iter().cloned().collect(),
            });
        }
    }
    let mut snapshots: Vec<_> = by_ticket.into_values().collect();
    snapshots.sort_by(|a, b| a.run_id.cmp(&b.run_id));
    Ok(snapshots)
}

/// Prove that an artifact command targets the authoritative terminal attempt.
/// Frontend state is only a projection and cannot authorize capture/approval.
pub(crate) async fn ensure_native_run_reviewable(
    workspace_id: &str,
    ticket_id: &str,
    run_id: &str,
    attempt_id: &str,
    workspace_path: &std::path::Path,
) -> Result<(), String> {
    let runs = NATIVE_RUNS.lock().await;
    if runs.values().any(|run| run.workspace_id == workspace_id && run.ticket_id == ticket_id) {
        return Err(format!(
            "ticket {ticket_id} still has an active or unreconciled native run"
        ));
    }
    let terminals = NATIVE_TERMINALS.lock().await;
    let snapshot = terminals
        .iter()
        .find(|snapshot| snapshot.run_id == run_id)
        .ok_or_else(|| format!("run {run_id} is not available for artifact review"))?;
    if snapshot.workspace_id != workspace_id
        || snapshot.ticket_id != ticket_id
        || snapshot.attempt_id != attempt_id
    {
        return Err("artifact identity does not match the native run".into());
    }
    if snapshot.status != "needs_review" {
        return Err(format!(
            "run {run_id} is {}, not needs_review",
            snapshot.status
        ));
    }
    let recorded = std::fs::canonicalize(&snapshot.cwd)
        .map_err(|error| format!("recorded workspace path: {error}"))?;
    if recorded != workspace_path {
        return Err("artifact workspace does not match the native run".into());
    }
    Ok(())
}

/// A live Designer session has no owned child to watch, so nothing can decide
/// for the user that its work is ready. This records their explicit "review
/// this" as a terminal attempt in `needs_review`, which is what capture and
/// approval bind to. It replaces any earlier terminal attempt for the ticket.
fn submit_session_attempt(
    runs: &HashMap<String, NativeRun>,
    terminals: &mut VecDeque<NativeRunSnapshot>,
    workspace_id: String,
    ticket_id: String,
    attempt_id: String,
    cwd: String,
) -> Result<NativeRunSnapshot, String> {
    if [workspace_id.as_str(), ticket_id.as_str(), attempt_id.as_str(), cwd.as_str()]
        .iter()
        .any(|value| value.trim().is_empty())
    {
        return Err("workspace_id, ticket_id, attempt_id and cwd are required".into());
    }
    if native_ticket_is_reserved(runs, &workspace_id, &ticket_id) {
        return Err(format!("ticket {ticket_id} still has an active native run"));
    }
    let snapshot = NativeRunSnapshot {
        run_id: format!("{workspace_id}:{ticket_id}:{attempt_id}"),
        workspace_id,
        ticket_id,
        attempt_id,
        cwd,
        provider: SESSION_PROVIDER.into(),
        status: "needs_review".into(),
        events: vec![json!({ "kind": "status", "status": "needs_review", "seq": 1 })],
    };
    terminals.retain(|old| {
        !(old.workspace_id == snapshot.workspace_id && old.ticket_id == snapshot.ticket_id)
    });
    if terminals.len() >= 50 {
        terminals.pop_front();
    }
    terminals.push_back(snapshot.clone());
    Ok(snapshot)
}

/// Provider name of an attempt submitted from a live Designer session.
pub const SESSION_PROVIDER: &str = "session";

#[tauri::command]
pub async fn native_session_submit(
    workspace_id: String,
    ticket_id: String,
    attempt_id: String,
    cwd: String,
) -> Result<NativeRunSnapshot, String> {
    let _review_guard = lock_native_review_action().await;
    std::fs::canonicalize(&cwd).map_err(|error| format!("session workspace path: {error}"))?;
    let runs = NATIVE_RUNS.lock().await;
    let mut terminals = NATIVE_TERMINALS.lock().await;
    submit_session_attempt(&runs, &mut terminals, workspace_id, ticket_id, attempt_id, cwd)
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeProviderAvailability {
    provider: String,
    available: bool,
    executable: Option<String>,
    detail: String,
}

#[tauri::command]
pub fn native_provider_status(cwd: Option<String>) -> Vec<NativeProviderAvailability> {
    let mut providers: Vec<NativeProviderAvailability> = ["claude", "codex"]
        .into_iter()
        .map(|provider| match crate::binresolve::resolve_bin(provider) {
            Ok(path) => NativeProviderAvailability {
                provider: provider.into(),
                available: true,
                executable: Some(path.display().to_string()),
                detail: "Installed; login is managed by the native CLI".into(),
            },
            Err(error) => NativeProviderAvailability {
                provider: provider.into(),
                available: false,
                executable: None,
                detail: error,
            },
        })
        .collect();

    // Code-da0.5 — conductor backends layered on the provider CLIs.
    let codex = providers.iter().find(|p| p.provider == "codex").cloned();
    let skill = crate::conductors::current_orchestrator_skill(cwd.as_deref().map(std::path::Path::new));
    providers.push(match (codex, skill) {
        (Some(codex), Some(skill)) if codex.available => NativeProviderAvailability {
            provider: crate::conductors::CODEX_ORCHESTRATOR.into(),
            available: true,
            executable: codex.executable,
            detail: format!("Sol plans, Luna workers implement; skill at {}", skill.display()),
        },
        (Some(codex), _) if !codex.available => NativeProviderAvailability {
            provider: crate::conductors::CODEX_ORCHESTRATOR.into(),
            available: false,
            executable: None,
            detail: format!("Requires Codex: {}", codex.detail),
        },
        _ => NativeProviderAvailability {
            provider: crate::conductors::CODEX_ORCHESTRATOR.into(),
            available: false,
            executable: None,
            detail: format!("Install the adaptive-orchestrator skill from {}", crate::conductors::ORCHESTRATOR_SOURCE),
        },
    });
    let claude = providers.iter().find(|p| p.provider == "claude").cloned();
    let opus_skill = crate::conductors::current_opus_conductor_skill(cwd.as_deref().map(std::path::Path::new));
    providers.push(match (claude, opus_skill) {
        (Some(claude), Some(skill)) if claude.available => NativeProviderAvailability {
            provider: crate::conductors::OPUS_CONDUCTOR.into(),
            available: true,
            executable: claude.executable,
            detail: format!("Opus plans, Sonnet workers implement, Haiku reads; skill at {}", skill.display()),
        },
        (Some(claude), _) if !claude.available => NativeProviderAvailability {
            provider: crate::conductors::OPUS_CONDUCTOR.into(),
            available: false,
            executable: None,
            detail: format!("Requires Claude Code: {}", claude.detail),
        },
        _ => NativeProviderAvailability {
            provider: crate::conductors::OPUS_CONDUCTOR.into(),
            available: false,
            executable: None,
            detail: crate::conductors::opus_missing_detail(crate::conductors::opus_conductor_dir().as_deref()),
        },
    });
    providers
}

#[tauri::command]
pub async fn native_run_start(
    window: Window,
    run_id: String,
    workspace_id: String,
    ticket_id: String,
    attempt_id: String,
    provider: String,
    cwd: String,
    prompt: String,
) -> Result<(), String> {
    // Starting the next attempt and approving/capturing the prior one are
    // mutually exclusive ticket-review transitions.
    let _review_guard = lock_native_review_action().await;
    if [run_id.as_str(), workspace_id.as_str(), ticket_id.as_str(), attempt_id.as_str()]
        .iter().any(|value| value.trim().is_empty()) || prompt.trim().is_empty()
    {
        return Err("run_id, workspace_id, ticket_id, attempt_id and prompt are required".into());
    }
    // Hold the registry lock through spawn+insert so two concurrent calls with
    // the same identity cannot both pass an optimistic contains check.
    let mut runs = NATIVE_RUNS.lock().await;
    if runs.contains_key(&run_id) {
        return Err(format!("run {run_id} is already active"));
    }
    if native_ticket_is_reserved(&runs, &workspace_id, &ticket_id) {
        return Err(format!("ticket {ticket_id} already has an active native run in workspace {workspace_id}"));
    }

    let permit = crate::spawngov::agent_permit()?;
    let mut child = spawn_native_child(&provider, &cwd, &prompt)?;
    let stdout = child.stdout.take().ok_or("provider stdout not captured")?;
    let stderr = child.stderr.take().ok_or("provider stderr not captured")?;
    runs.insert(run_id.clone(), NativeRun {
        child: Some(child),
        workspace_id,
        ticket_id,
        attempt_id,
        cwd,
        provider: provider.clone(),
        events: VecDeque::new(),
        next_seq: 1,
        drained: false,
        cancel_requested: false,
        unknown: false,
        _permit: permit,
    });
    drop(runs);

    let channel = format!("native_run_event:{}", chan_id(&run_id));
    emit_native_event(&window, &run_id, json!({ "kind": "status", "status": "running", "provider": provider })).await;
    let output_window = window.clone();
    let output_run_id = run_id.clone();
    let output_task = tokio::spawn(async move {
        drain_native_output(stdout, &output_run_id, Some(&output_window), false).await
    });
    let error_window = window.clone();
    let error_run_id = run_id.clone();
    let error_task = tokio::spawn(async move {
        drain_native_output(stderr, &error_run_id, Some(&error_window), true).await
    });
    tokio::spawn(async move {
        let (output, error) = tokio::join!(output_task, error_task);
        if let Some(run) = NATIVE_RUNS.lock().await.get_mut(&run_id) {
            run.drained = matches!(output, Ok(Ok(()))) && matches!(error, Ok(Ok(())));
            run.unknown |= !run.drained;
        }
        // Poll without taking the child: closing stdout/stderr does not mean
        // the process exited, and cancellation must still reach that child.
        loop {
            match poll_native_completion(&run_id).await {
                Ok(Some(event)) => { let _ = window.emit(&channel, event); break; }
                Ok(None) => tokio::time::sleep(std::time::Duration::from_millis(25)).await,
                Err(_) => break, // ownership remains available for check/cancel
            }
        }
    });
    Ok(())
}

/// Resolve the backend binary and spawn one Designer run child with piped
/// output. Shared by `native_run_start` and the opt-in live provider test.
fn spawn_native_child(provider: &str, cwd: &str, prompt: &str) -> Result<Child, String> {
    let binary = match provider {
        "claude" | "codex" => crate::binresolve::resolve_bin(provider)
            .map_err(|e| format!("{provider} is unavailable: {e}"))?,
        crate::conductors::CODEX_ORCHESTRATOR => {
            crate::conductors::current_orchestrator_skill(Some(std::path::Path::new(cwd)))
                .ok_or_else(|| format!("adaptive-orchestrator skill is not installed; see {}", crate::conductors::ORCHESTRATOR_SOURCE))?;
            crate::binresolve::resolve_bin("codex").map_err(|e| format!("codex is unavailable: {e}"))?
        }
        crate::conductors::OPUS_CONDUCTOR => {
            crate::conductors::current_opus_conductor_skill(Some(std::path::Path::new(cwd)))
                .ok_or_else(|| crate::conductors::opus_missing_detail(crate::conductors::opus_conductor_dir().as_deref()))?;
            crate::binresolve::resolve_bin("claude").map_err(|e| format!("claude is unavailable: {e}"))?
        }
        _ => return Err(format!("unsupported provider {provider}")),
    };
    Command::new(binary)
        .args(native_run_args(provider, cwd, prompt)?)
        .current_dir(cwd)
        .env("PATH", augmented_path())
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start {provider}: {e}"))
}

/// Non-interactive CLI arguments for a Designer run. `codex exec` has no
/// `--ask-for-approval` flag (0.155 rejects it), so the approval policy is
/// set through a config override, which every exec version accepts.
fn native_run_args(provider: &str, cwd: &str, prompt: &str) -> Result<Vec<String>, String> {
    match provider {
        "claude" => Ok(vec![
            "--print".into(),
            "--verbose".into(),
            "--output-format=stream-json".into(),
            "--permission-mode=acceptEdits".into(),
            "--add-dir".into(),
            cwd.into(),
            prompt.into(),
        ]),
        // The conductor's design is an Opus primary that delegates downward;
        // its agents pin their own models, so only the primary is named here.
        crate::conductors::OPUS_CONDUCTOR => Ok(vec![
            "--print".into(),
            "--verbose".into(),
            "--output-format=stream-json".into(),
            "--permission-mode=acceptEdits".into(),
            "--model".into(),
            "opus".into(),
            "--add-dir".into(),
            cwd.into(),
            crate::conductors::opus_conductor_prompt(prompt),
        ]),
        "codex" | crate::conductors::CODEX_ORCHESTRATOR => {
            let prompt = if provider == crate::conductors::CODEX_ORCHESTRATOR {
                crate::conductors::orchestrator_prompt(prompt)
            } else {
                prompt.to_string()
            };
            Ok(vec![
                "exec".into(),
                "--json".into(),
                "--sandbox=workspace-write".into(),
                "-c".into(),
                "approval_policy=\"never\"".into(),
                "--cd".into(),
                cwd.into(),
                prompt,
            ])
        }
        other => Err(format!("unsupported provider {other}")),
    }
}

#[tauri::command]
pub async fn native_run_cancel(window: Window, run_id: String) -> Result<(), String> {
    let (status, seq) = cancel_native_run_process(&run_id).await?;
    let channel = format!("native_run_event:{}", chan_id(&run_id));
    let _ = window.emit(&channel, json!({ "kind": "status", "status": status, "seq": seq }));
    Ok(())
}

async fn drain_native_output<R: tokio::io::AsyncRead + Unpin>(
    reader: R, run_id: &str, window: Option<&Window>, stderr: bool,
) -> Result<(), std::io::Error> {
    let mut lines = BufReader::new(reader).lines();
    while let Some(line) = lines.next_line().await? {
        let event = if stderr { json!({ "kind": "stderr", "line": line }) }
            else { json!({ "kind": "output", "parsed": serde_json::from_str::<Value>(&line).ok(), "line": line }) };
        if let Some(event) = record_native_event(run_id, event).await {
            if let Some(window) = window {
                let _ = window.emit(&format!("native_run_event:{}", chan_id(run_id)), event);
            }
        }
    }
    Ok(())
}

// All registry transitions use RUNS -> TERMINALS. Admission stays reserved
// until the exact child has been reaped AND both output readers have finished.
async fn poll_native_completion(run_id: &str) -> Result<Option<Value>, String> {
    let mut runs = NATIVE_RUNS.lock().await;
    let Some(run) = runs.get_mut(run_id) else {
        return NATIVE_TERMINALS.lock().await.iter().find(|s| s.run_id == run_id)
            .and_then(|s| s.events.last().cloned()).map(Some)
            .ok_or_else(|| format!("run {run_id} ownership was lost"));
    };
    let exit = match run.child.as_mut().ok_or("child ownership unavailable")?.try_wait() {
        Ok(exit) => exit,
        Err(error) => { run.unknown = true; return Err(format!("reap run {run_id}: {error}")); }
    };
    let Some(exit) = exit else { return Ok(None) };
    if !run.drained { return Ok(None); }
    let status = if run.cancel_requested { "cancelled" }
        else if exit.success() { "needs_review" } else { "failed" };
    retain_native_terminal(&mut runs, run_id, status).await.map(Some)
}

async fn cancel_native_run_process(run_id: &str) -> Result<(&'static str, u64), String> {
    cancel_native_run_with_timeout(run_id, std::time::Duration::from_secs(5)).await
}

async fn cancel_native_run_with_timeout(run_id: &str, timeout: std::time::Duration) -> Result<(&'static str, u64), String> {
    {
        let mut runs = NATIVE_RUNS.lock().await;
        if let Some(run) = runs.get_mut(run_id) {
            let child = run.child.as_mut().ok_or("child ownership unavailable")?;
            match child.try_wait() {
                Ok(Some(_)) => {} // preserve a process that already completed
                Ok(None) => {
                    if let Err(error) = child.start_kill() {
                        run.unknown = true;
                        return Err(format!("kill run {run_id}: {error}"));
                    }
                    run.cancel_requested = true;
                }
                Err(error) => { run.unknown = true; return Err(format!("reap run {run_id}: {error}")); }
            }
        }
    }
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Some(event) = poll_native_completion(run_id).await? {
            let status = match event["status"].as_str() {
                Some("cancelled") => "cancelled",
                Some("needs_review") => "needs_review",
                _ => "failed",
            };
            return Ok((status, event["seq"].as_u64().unwrap()));
        }
        if tokio::time::Instant::now() >= deadline {
            if let Some(run) = NATIVE_RUNS.lock().await.get_mut(run_id) { run.unknown = true; }
            return Err(format!("run {run_id} cancellation is unconfirmed: waiting for reap/output drain; check status"));
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

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
    // Code-4je: when true, pass --resume instead of --session-id.
    resume: Option<bool>,
) -> Result<String, String> {
    // Code-urn fix: hold SESSIONS only for the O(1) idempotency check, then
    // DROP it before the child `.spawn()`. Holding the lock across the fork
    // serialized concurrent starts (two `<leader>a` spawns would block on one
    // mutex through a process fork). Scope the guard so it releases here.
    {
        let mut guard = SESSIONS.lock().await;
        if let Some(existing) = guard.get_mut(&project_id) {
            // Liveness check: a session may exist in the map but its child has
            // already exited (e.g. claude died on a bad ANTHROPIC_BASE_URL /
            // auth). Returning the corpse means every claude_send writes to a
            // dead stdin -> "Broken pipe (os error 32)". try_wait() is
            // non-blocking: Ok(Some(_)) => process exited; Ok(None) => alive.
            match existing.child.try_wait() {
                Ok(Some(_status)) => {
                    // Dead — evict and fall through to respawn a fresh session.
                    guard.remove(&project_id);
                }
                _ => return Ok(existing.session_id.clone()), // alive (or unknowable) — reuse
            }
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

    // Resolve claude binary via binresolve (searches ~/.local/bin, homebrew,
    // nvm, PATH, and honors BS_CLAUDE_BIN). No hardcoded fallback path anymore —
    // the old one pointed at one developer's home and was dead on any other
    // machine or a packaged .app. Emit a diagnostic event so we can tell from
    // the frontend exactly which binary + cwd we're spawning under.
    let claude_path = crate::binresolve::resolve_bin("claude")
        .map_err(|e| format!("resolve claude binary: {e}"))?;
    let path_env = augmented_path();

    {
        let api_key_present = std::env::var("ANTHROPIC_API_KEY")
            .map(|v| !v.is_empty())
            .unwrap_or(false);
        let base_url = std::env::var("ANTHROPIC_BASE_URL")
            .unwrap_or_else(|_| "<unset>".into());
        // Startup diagnostic: stderr + tracing only. It used to also
        // window.emit on the raw channel, which dumped a wall of PATH text into
        // the chat scroll on every (re)start (incl. "new session"). The raw
        // channel is reserved for genuinely-unparseable claude stdout.
        let msg = format!(
            "[claude_start] cwd={cwd} bin={} api_key_present={api_key_present} base_url={base_url} (PATH={path_env})",
            claude_path.display()
        );
        eprintln!("{msg}");
    }

    let mut cmd = Command::new(&claude_path);
    cmd.arg("--print")
        .arg("--verbose")
        .arg("--input-format=stream-json")
        .arg("--output-format=stream-json")
        .arg("--include-partial-messages")
        .arg("--include-hook-events")
        // Code-4je: --resume replays transcript; --session-id is ignored by the
        // CLI (it assigns its own). Only pass --resume when the caller confirmed
        // the id came from the CLI (resume=true).
        .args(if resume.unwrap_or(false) && !session_id.is_empty() {
            vec!["--resume".to_string(), session_id.clone()]
        } else if !session_id.is_empty() {
            vec!["--session-id".to_string(), session_id.clone()]
        } else {
            vec![]
        })
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

    // EXP backbone: acquire a spawn-governor permit BEFORE forking claude, and
    // hold it for the child's whole life (moved into ClaudeSession below). This
    // is the one long-lived-child slot the old bd-only cap never counted — the
    // biggest fd/fork consumer. On the lost-race branch below the permit drops
    // with the redundant child, freeing the slot immediately.
    let permit = crate::spawngov::agent_permit()?;

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
            let event_name = format!("claude_event:{}", chan_id(&pid));
            let raw_event_name = format!("claude_event_raw:{}", chan_id(&pid));
            let status_event_name = format!("claude_status:{}", chan_id(&pid));
            let mut reader = BufReader::new(stdout).lines();
            loop {
                match reader.next_line().await {
                    Ok(Some(line)) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Value>(trimmed) {
                            Ok(mut value) => {
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
                                        // Code-4je: the CLI emits its own session_id in
                                        // the first system/init frame, ignoring our
                                        // --session-id arg. Capture and overwrite so the
                                        // FE can persist the CLI-assigned id and use
                                        // --resume on the next mount.
                                        "system" => {
                                            if value.get("subtype").and_then(Value::as_str) == Some("init") {
                                                if let Some(cli_sid) = value.get("session_id").and_then(Value::as_str) {
                                                    let mut guard = SESSIONS.lock().await;
                                                    if let Some(session) = guard.get_mut(&pid) {
                                                        session.session_id = cli_sid.to_string();
                                                    }
                                                }
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                                // Code-lbi: push to scrollback ring buffer.
                                {
                                    let mut sb = SCROLLBACK.lock().await;
                                    let ring = sb.entry(pid.clone()).or_default();
                                    let next_seq = ring
                                        .back()
                                        .and_then(|previous| previous.get("_bs_seq"))
                                        .and_then(Value::as_u64)
                                        .map_or(0, |previous| previous.saturating_add(1));
                                    if let Some(object) = value.as_object_mut() {
                                        object.insert("_bs_seq".into(), json!(next_seq));
                                    }
                                    if ring.len() >= SCROLLBACK_CAP {
                                        ring.pop_front();
                                    }
                                    ring.push_back(value.clone());
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
                    Ok(None) => {
                        // Code-key: PTY/stdout EOF means child exited. Evict from
                        // SESSIONS and notify the FE so it can offer respawn.
                        SESSIONS.lock().await.remove(&pid);
                        let _ = win.emit(&status_event_name, "exited");
                        break;
                    }
                    Err(e) => {
                        let _ = win.emit(&raw_event_name, format!("[stdout read error] {e}"));
                        SESSIONS.lock().await.remove(&pid);
                        let _ = win.emit(&status_event_name, "exited");
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
            let event_name = format!("claude_stderr:{}", chan_id(&pid));
            let status_event_name = format!("claude_status:{}", chan_id(&pid));
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
            // Lost the same-bridge race: free the governor slot immediately,
            // then reap the redundant child outside the map lock.
            drop(permit);
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
                _permit: permit,
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
    if let Err(e) = stdin.write_all(line.as_bytes()).await {
        // A broken pipe means the child died since we cloned its stdin. Evict
        // the dead session so the next claude_start respawns instead of writing
        // to a corpse forever. Return a typed marker the FE can retry on.
        drop(stdin);
        SESSIONS.lock().await.remove(&project_id);
        return Err(format!("session dead: write to claude stdin: {e}"));
    }
    if let Err(e) = stdin.flush().await {
        drop(stdin);
        SESSIONS.lock().await.remove(&project_id);
        return Err(format!("session dead: flush claude stdin: {e}"));
    }

    Ok(())
}

#[tauri::command]
pub async fn claude_kill(project_id: String) -> Result<(), String> {
    // Drop the SESSIONS lock before wait() so concurrent claude_start calls
    // are not serialized behind the dying child's OS reap (Node exit can take
    // ~1-2s; holding the lock across that stalled every new project's chat).
    let evicted = {
        let mut guard = SESSIONS.lock().await;
        guard.remove(&project_id)
    };
    if let Some(mut session) = evicted {
        let _ = session.child.start_kill();
        let _ = session.child.wait().await;
    }
    SCROLLBACK.lock().await.remove(&project_id);
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
    drop(guard);
    SCROLLBACK.lock().await.clear();
    for mut session in drained {
        let _ = session.child.start_kill();
        let _ = session.child.wait().await;
    }
    let native: Vec<NativeRun> = NATIVE_RUNS.lock().await.drain().map(|(_, run)| run).collect();
    let codex = crate::codex::kill_all_codex_sessions().await;
    let total = n + native.len() + codex;
    for mut run in native {
        if let Some(mut child) = run.child.take() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    }
    total
}

pub async fn active_close_scope() -> (usize, usize) {
    (SESSIONS.lock().await.len(), NATIVE_RUNS.lock().await.len())
}

/// Code-4je — return the CLI-assigned session_id for a running bridge. The
/// FE calls this after the first frame arrives (or after mount) to get the
/// id it should persist and pass back as --resume on the next mount.
#[tauri::command]
pub async fn claude_get_session_id(project_id: String) -> Result<Option<String>, String> {
    let guard = SESSIONS.lock().await;
    Ok(guard.get(&project_id).map(|s| s.session_id.clone()))
}

/// Code-lbi — replay buffered frames to a late-mounting listener. Returns
/// the last up-to-SCROLLBACK_CAP parsed JSON frames emitted for this bridge
/// since it was started. The FE calls this immediately after registering its
/// claude_event listener; replaying the ring closes the race between listener
/// registration and early frames emitted during process startup.
#[tauri::command]
pub async fn claude_get_scrollback(project_id: String) -> Result<Vec<Value>, String> {
    let sb = SCROLLBACK.lock().await;
    Ok(sb.get(&project_id).map(|ring| ring.iter().cloned().collect()).unwrap_or_default())
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
    let stale: Vec<(String, ClaudeSession)> = {
        let mut guard = SESSIONS.lock().await;
        let stale_keys: Vec<String> = guard
            .keys()
            .filter(|k| !live.contains(*k))
            .cloned()
            .collect();
        stale_keys
            .into_iter()
            .filter_map(|k| guard.remove(&k).map(|s| (k, s)))
            .collect()
    };
    let n = stale.len();
    if n > 0 {
        let mut sb = SCROLLBACK.lock().await;
        for (k, _) in &stale { sb.remove(k); }
    }
    for (_, mut session) in stale {
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

    async fn fake_native_run(workspace_id: &str, ticket_id: &str, attempt_id: &str) -> (NativeRun, u32) {
        let child = Command::new("sh")
            .arg("-c")
            .arg("exec sleep 30")
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        // Isolate fixture permits from parallel tests; production capacity has
        // its own spawngov tests. The lifecycle still owns a real permit.
        let permit = Arc::new(tokio::sync::Semaphore::new(1)).acquire_owned().await.unwrap();
        (NativeRun {
            child: Some(child),
            workspace_id: workspace_id.into(),
            ticket_id: ticket_id.into(),
            attempt_id: attempt_id.into(),
            cwd: "/tmp".into(),
            provider: "fake".into(),
            events: VecDeque::new(),
            next_seq: 1,
            drained: true, // this helper has no captured pipes
            cancel_requested: false,
            unknown: false,
            _permit: permit,
        }, pid)
    }

    #[test]
    fn chan_id_sanitizes_illegal_chars() {
        // Code-6w0: the concrete regression — a space in the repo basename.
        assert_eq!(chan_id("All Doors"), "All_Doors");
        // Allowed set is preserved verbatim.
        assert_eq!(chan_id("agent1"), "agent1");
        assert_eq!(chan_id("a-b/c:d_e"), "a-b/c:d_e");
        // Other whitespace / punctuation collapses to underscore.
        assert_eq!(chan_id("a b\tc.d"), "a_b_c_d");
    }

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

    #[tokio::test]
    async fn a_submitted_session_attempt_is_reviewable_and_replaces_the_previous_one() {
        let cwd = std::fs::canonicalize("/tmp").unwrap();
        let path = cwd.to_string_lossy().into_owned();
        let workspace = format!("workspace-session-{}", std::process::id());
        let first = native_session_submit(workspace.clone(), "Code-session".into(), "attempt-1".into(), path.clone())
            .await
            .unwrap();
        assert_eq!(first.provider, SESSION_PROVIDER);
        assert_eq!(first.status, "needs_review");
        ensure_native_run_reviewable(&workspace, "Code-session", &first.run_id, "attempt-1", &cwd)
            .await
            .expect("first attempt reviewable");

        let second = native_session_submit(workspace.clone(), "Code-session".into(), "attempt-2".into(), path.clone())
            .await
            .unwrap();
        ensure_native_run_reviewable(&workspace, "Code-session", &second.run_id, "attempt-2", &cwd)
            .await
            .expect("second attempt reviewable");
        // Approval can no longer be bound to the attempt the user moved on from.
        assert!(ensure_native_run_reviewable(&workspace, "Code-session", &first.run_id, "attempt-1", &cwd)
            .await
            .is_err());
        assert!(native_session_submit(workspace, "Code-session".into(), " ".into(), path).await.is_err());
    }

    #[tokio::test]
    async fn artifact_review_requires_the_exact_successful_terminal_attempt() {
        let run_id = format!("artifact-review-{}", std::process::id());
        let cwd = std::fs::canonicalize("/tmp").unwrap();
        NATIVE_TERMINALS.lock().await.push_back(NativeRunSnapshot {
            run_id: run_id.clone(),
            workspace_id: "workspace-artifact".into(),
            ticket_id: "Code-artifact".into(),
            attempt_id: "attempt-artifact".into(),
            cwd: cwd.to_string_lossy().into_owned(),
            provider: "fake".into(),
            status: "failed".into(),
            events: Vec::new(),
        });
        assert!(ensure_native_run_reviewable(
            "workspace-artifact",
            "Code-artifact",
            &run_id,
            "attempt-artifact",
            &cwd,
        )
        .await
        .unwrap_err()
        .contains("not needs_review"));
        NATIVE_TERMINALS
            .lock()
            .await
            .iter_mut()
            .find(|snapshot| snapshot.run_id == run_id)
            .unwrap()
            .status = "needs_review".into();
        assert!(ensure_native_run_reviewable(
            "workspace-artifact",
            "Code-artifact",
            &run_id,
            "wrong-attempt",
            &cwd,
        )
        .await
        .is_err());
        ensure_native_run_reviewable(
            "workspace-artifact",
            "Code-artifact",
            &run_id,
            "attempt-artifact",
            &cwd,
        )
        .await
        .unwrap();
        NATIVE_TERMINALS
            .lock()
            .await
            .retain(|snapshot| snapshot.run_id != run_id);
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

    #[tokio::test]
    async fn native_snapshot_retains_identity_order_and_reconciles_repeatedly() {
        let run_id = "native-snapshot-test".to_string();
        let (run, _) = fake_native_run("workspace-a", "Code-test", "attempt-a").await;
        NATIVE_RUNS.lock().await.insert(run_id.clone(), run);
        record_native_event(&run_id, json!({ "kind": "output", "line": "one" })).await;
        record_native_event(&run_id, json!({ "kind": "output", "line": "two" })).await;

        let first = native_run_snapshot("workspace-a".into()).await.unwrap();
        let second = native_run_snapshot("workspace-a".into()).await.unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        assert_eq!(first[0].run_id, run_id);
        assert_eq!(first[0].ticket_id, "Code-test");
        assert_eq!(first[0].attempt_id, "attempt-a");
        assert_eq!(first[0].events[0]["seq"], 1);
        assert_eq!(first[0].events[1]["seq"], 2);

        let mut removed = NATIVE_RUNS.lock().await.remove(&run_id).unwrap();
        let mut child = removed.child.take().unwrap();
        child.start_kill().unwrap();
        child.wait().await.unwrap();
        assert!(native_run_snapshot("workspace-a".into()).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancelling_by_run_id_reaps_only_that_fake_child() {
        let (first, first_pid) = fake_native_run("workspace-b", "Code-one", "attempt-one").await;
        let (second, _) = fake_native_run("workspace-b", "Code-two", "attempt-two").await;
        NATIVE_RUNS.lock().await.insert("cancel-first".into(), first);
        NATIVE_RUNS.lock().await.insert("keep-second".into(), second);
        {
            let mut runs = NATIVE_RUNS.lock().await;
            let child = runs.get_mut("cancel-first").unwrap().child.take().unwrap();
            assert!(native_ticket_is_reserved(&runs, "workspace-b", "Code-one"));
            runs.get_mut("cancel-first").unwrap().child = Some(child);
        }

        let (status, _) = cancel_native_run_process("cancel-first").await.unwrap();
        assert_eq!(status, "cancelled");
        let probe = std::process::Command::new("ps")
            .args(["-p", &first_pid.to_string(), "-o", "pid="])
            .output()
            .unwrap();
        assert!(probe.stdout.is_empty(), "cancel must reap the exact child pid {first_pid}");
        assert!(!NATIVE_RUNS.lock().await.contains_key("cancel-first"));
        assert!(NATIVE_RUNS.lock().await.contains_key("keep-second"));
        let cancelled = native_run_snapshot("workspace-b".into()).await.unwrap();
        assert_eq!(cancelled.iter().find(|run| run.run_id == "cancel-first").unwrap().status, "cancelled");

        let mut survivor = NATIVE_RUNS.lock().await.remove("keep-second").unwrap();
        let mut child = survivor.child.take().unwrap();
        child.start_kill().unwrap();
        child.wait().await.unwrap();
    }
    #[tokio::test]
    async fn cancellation_kills_before_drain_and_snapshot_has_no_transition_gap() {
        let id = "cancel-piped";
        let (mut run, _) = fake_native_run("workspace-piped", "ticket", "attempt").await;
        // Replace the helper's null-pipe child with a real pipe-holding child.
        run.child.as_mut().unwrap().kill().await.unwrap();
        let mut child = Command::new("sh").args(["-c", "echo ready; exec sleep 30"])
            .stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        run.child = Some(child);
        run.drained = false;
        NATIVE_RUNS.lock().await.insert(id.into(), run);
        let readers = tokio::spawn(async move {
            let (a, b) = tokio::join!(drain_native_output(stdout, id, None, false), drain_native_output(stderr, id, None, true));
            a.unwrap(); b.unwrap();
            // Widen the reaped-but-not-yet-drained window deliberately.
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            assert!(native_ticket_is_reserved(&*NATIVE_RUNS.lock().await, "workspace-piped", "ticket"));
            NATIVE_RUNS.lock().await.get_mut(id).unwrap().drained = true;
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if !NATIVE_RUNS.lock().await.get(id).unwrap().events.is_empty() { break; }
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
        let cancel = tokio::spawn(cancel_native_run_process(id));
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let snapshot = native_run_snapshot("workspace-piped".into()).await.unwrap();
                assert_eq!(snapshot.len(), 1, "active-to-terminal must remain visible");
                if cancel.is_finished() { break; }
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
        }).await.unwrap();
        let (status, seq) = tokio::time::timeout(std::time::Duration::from_secs(2), cancel).await.unwrap().unwrap().unwrap();
        readers.await.unwrap();
        assert_eq!(status, "cancelled");
        let snapshot = native_run_snapshot("workspace-piped".into()).await.unwrap();
        assert!(snapshot[0].events.iter().any(|e| e["line"] == "ready"));
        assert_eq!(snapshot[0].events.last().unwrap()["seq"], seq);
        assert_eq!(cancel_native_run_process(id).await.unwrap(), (status, seq));
    }

    #[tokio::test]
    async fn completion_poll_keeps_live_child_cancellable_after_pipes_close() {
        let id = "closed-pipes";
        let (run, _) = fake_native_run("workspace-closed", "ticket", "attempt").await;
        NATIVE_RUNS.lock().await.insert(id.into(), run); // null pipes are already drained
        assert!(poll_native_completion(id).await.unwrap().is_none());
        assert!(NATIVE_RUNS.lock().await.get(id).unwrap().child.is_some());
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), cancel_native_run_process(id)).await.unwrap().unwrap();
        assert_eq!(result.0, "cancelled");
    }

    #[tokio::test]
    async fn cancellation_preserves_already_exited_success() {
        let id = "already-exited";
        let (mut run, _) = fake_native_run("workspace-exit", "ticket", "attempt").await;
        run.child.as_mut().unwrap().kill().await.unwrap();
        let mut child = Command::new("sh").args(["-c", "exit 0"]).spawn().unwrap();
        child.wait().await.unwrap();
        run.child = Some(child);
        NATIVE_RUNS.lock().await.insert(id.into(), run);
        assert_eq!(cancel_native_run_process(id).await.unwrap().0, "needs_review");
    }

    #[tokio::test]
    async fn drain_timeout_retains_unknown_ownership_until_reconciled() {
        let id = "drain-timeout";
        let (mut run, _) = fake_native_run("workspace-timeout", "ticket", "attempt").await;
        run.drained = false;
        NATIVE_RUNS.lock().await.insert(id.into(), run);
        let error = cancel_native_run_with_timeout(id, std::time::Duration::from_millis(30)).await.unwrap_err();
        assert!(error.contains("unconfirmed"));
        let snapshot = native_run_snapshot("workspace-timeout".into()).await.unwrap();
        assert_eq!(snapshot[0].status, "unknown");
        assert!(snapshot[0].events.is_empty(), "no terminal sequence before drain");
        {
            let mut runs = NATIVE_RUNS.lock().await;
            assert!(native_ticket_is_reserved(&runs, "workspace-timeout", "ticket"));
            assert!(runs.get(id).unwrap().child.is_some());
            runs.get_mut(id).unwrap().drained = true;
        }
        assert_eq!(poll_native_completion(id).await.unwrap().unwrap()["status"], "cancelled");
    }

    #[test]
    fn codex_exec_args_avoid_removed_approval_flag() {
        for provider in ["codex", crate::conductors::CODEX_ORCHESTRATOR] {
            let args = native_run_args(provider, "/ws", "Work on ticket X").unwrap();
            assert_eq!(&args[..7], ["exec", "--json", "--sandbox=workspace-write", "-c", "approval_policy=\"never\"", "--cd", "/ws"]);
            assert!(!args.iter().any(|arg| arg.starts_with("--ask-for-approval")));
            assert!(args.last().unwrap().ends_with("Work on ticket X"));
        }
        assert!(native_run_args("unknown-backend", "/ws", "x").is_err());
    }

    #[test]
    fn opus_conductor_runs_claude_with_an_opus_primary_and_the_orchestrator_preamble() {
        let args = native_run_args(crate::conductors::OPUS_CONDUCTOR, "/ws", "Work on ticket X").unwrap();
        assert_eq!(&args[..8], ["--print", "--verbose", "--output-format=stream-json", "--permission-mode=acceptEdits", "--model", "opus", "--add-dir", "/ws"]);
        let prompt = args.last().unwrap();
        assert!(prompt.starts_with("Use the adaptive-orchestrator skill"));
        assert!(prompt.ends_with("Work on ticket X"));
        // A plain Claude run names no model: the CLI's own configuration decides.
        assert!(!native_run_args("claude", "/ws", "x").unwrap().contains(&"--model".to_string()));
    }

    /// Opt-in paid provider run: the Designer backend path without the
    /// webview. Spawn the chosen conductor exactly as `native_run_start`
    /// does, drain its output, reach `needs_review`, then capture the
    /// artifact and prove approval binds to that exact revision.
    ///
    ///   BS_LIVE_WORKSPACE=<clean git repo> BS_LIVE_TICKET=<id> \
    ///   [BS_LIVE_PROVIDER=codex-orchestrator] [BS_LIVE_PROMPT=...] \
    ///   cargo test --manifest-path src-tauri/Cargo.toml live_designer_run -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "spends provider quota; set BS_LIVE_WORKSPACE"]
    async fn live_designer_run_reaches_review_and_binds_approval() {
        let Ok(cwd) = std::env::var("BS_LIVE_WORKSPACE") else { return };
        let ticket = std::env::var("BS_LIVE_TICKET").unwrap_or_else(|_| "live-ticket".into());
        let provider = std::env::var("BS_LIVE_PROVIDER").unwrap_or_else(|_| crate::conductors::CODEX_ORCHESTRATOR.into());
        let prompt = std::env::var("BS_LIVE_PROMPT").unwrap_or_else(|_| format!("Work on ticket {ticket}. Run `bd show {ticket}` for the request."));
        let (workspace, attempt) = ("live-workspace", format!("attempt-{}", std::process::id()));
        let run_id = format!("{workspace}:{ticket}:{attempt}");

        let mut child = spawn_native_child(&provider, &cwd, &prompt).expect("spawn");
        let (stdout, stderr) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
        let permit = Arc::new(tokio::sync::Semaphore::new(1)).acquire_owned().await.unwrap();
        NATIVE_RUNS.lock().await.insert(run_id.clone(), NativeRun {
            child: Some(child), workspace_id: workspace.into(), ticket_id: ticket.clone(),
            attempt_id: attempt.clone(), cwd: cwd.clone(), provider: provider.clone(),
            events: VecDeque::new(), next_seq: 1, drained: false, cancel_requested: false,
            unknown: false, _permit: permit,
        });
        let (out, err) = tokio::join!(
            drain_native_output(stdout, &run_id, None, false),
            drain_native_output(stderr, &run_id, None, true),
        );
        NATIVE_RUNS.lock().await.get_mut(&run_id).unwrap().drained = out.is_ok() && err.is_ok();
        let terminal = loop {
            if let Some(event) = poll_native_completion(&run_id).await.unwrap() { break event; }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        };
        let snapshot = native_run_snapshot(workspace.into()).await.unwrap().remove(0);
        for event in snapshot.events.iter().filter(|e| e["kind"] != "output" || e["parsed"]["type"] != "item.updated") {
            let line = event["line"].as_str().map(|l| l.chars().take(240).collect::<String>());
            eprintln!("[{}] {}", event["kind"], line.unwrap_or_else(|| event.to_string()));
        }
        assert_eq!(terminal["status"], "needs_review", "run did not finish cleanly");

        let root = std::fs::canonicalize(&cwd).unwrap();
        ensure_native_run_reviewable(workspace, &ticket, &run_id, &attempt, &root).await.expect("reviewable");
        let args = crate::artifacts::CaptureArgs {
            workspace_id: workspace.into(), ticket_id: ticket.clone(), run_id: run_id.clone(),
            attempt_id: attempt.clone(), workspace_path: cwd.clone(),
        };
        let revision = crate::artifacts::capture_inner(&args).expect("capture");
        eprintln!("revision {} files {:?}", revision.revision_id,
            revision.files.iter().map(|f| format!("{} {}", f.status, f.path)).collect::<Vec<_>>());
        assert!(!revision.files.is_empty(), "the run changed nothing");
        // artifact_approve recaptures and requires the same hash; any later
        // workspace change must invalidate the captured revision.
        assert_eq!(crate::artifacts::capture_inner(&args).unwrap().revision_hash, revision.revision_hash);
        let probe = root.join(".bs-live-stale-probe");
        std::fs::write(&probe, b"stale").unwrap();
        let stale = crate::artifacts::capture_inner(&args).unwrap().revision_hash;
        std::fs::remove_file(&probe).unwrap();
        assert_ne!(stale, revision.revision_hash, "stale approval would not be detected");
    }

}
