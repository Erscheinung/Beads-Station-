// Beads Station — RV4.1: the conductor pulse (bd ticket Code-wvl).
//
// A tokio-interval scheduler that fires ONE ephemeral `claude` run per tick.
// Each pulse: bd prime (context) -> bd doctor (health gate) -> bd ready (pick
// the top bead) -> a one-shot `claude -p` run that advances exactly one
// molecule step in bd -> bd remember (heartbeat). State lives ENTIRELY in bd,
// so a crashed/killed pulse costs at most one retried step, never a corrupted
// brain: the next pulse re-derives its position from `bd ready` / `bd mol`.
//
// Safety posture (locked 2026-08-11):
//   1. Default OFF. Nothing auto-starts in lib.rs::setup — a live claude pulse
//      fires only after an explicit `conductor_start`.
//   2. bd-state only. The pulse ships in dry-run/plan posture by default
//      (`claude --permission-mode plan`): claude reasons + runs read-only bd
//      verbs but makes no edits/commits. Real code changes stay gated behind
//      the formula's human gate (RV5.0). `dry_run: Some(false)` opts into
//      `acceptEdits` deliberately.
//
// This is the FIRST use of `tokio::sync::Notify` + `tokio::select!` in the
// backend. The interval loop selects between the stop-notify and the tick; a
// graceful stop halts the SCHEDULE at the next loop boundary, never aborting an
// in-flight pulse (that step is durable in bd regardless).

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::bd;
use crate::binresolve;
use crate::claude;

/// Default pulse cadence: 20 minutes.
const DEFAULT_INTERVAL_SECS: u64 = 1200;
/// Floor so a `0`/tiny interval can't busy-spin claude.
const MIN_INTERVAL_SECS: u64 = 10;
/// Off-minute jitter ceiling (a one-time pre-loop offset).
const JITTER_MAX_SECS: u64 = 45;
/// Hard cap on a single pulse. Kept well under the default interval so ticks
/// never overlap (paired with MissedTickBehavior::Skip).
const PULSE_TIMEOUT: Duration = Duration::from_secs(600);
/// Cheap model for the mechanical one-step pulse.
const PULSE_MODEL: &str = "claude-haiku-4-5-20251001";

struct ConductorState {
    repo_path: String,
    interval_secs: u64,
    stop: Arc<tokio::sync::Notify>,
}

static CONDUCTOR: Lazy<Mutex<Option<ConductorState>>> = Lazy::new(|| Mutex::new(None));

/// App-global status event (un-namespaced, telemetry idiom). Drives the
/// Designer-UI "Claude is awake" footer + the DU3 active-agents panel.
///
/// `state` wire contract: "waking" | "awake" | "idle" | "deferred" | "error"
/// | "stopped".
#[derive(Serialize, Clone)]
pub struct ConductorStatus {
    pub state: &'static str,
    pub bead_id: Option<String>,
    pub detail: Option<String>,
    pub last_pulse_ms: Option<u128>,
    pub interval_secs: u64,
    pub repo_path: String,
}

fn emit_status(app: &AppHandle, status: ConductorStatus) {
    let _ = app.emit("conductor_status", status);
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn now_rfc3339_ish() -> String {
    // Avoid pulling a datetime crate: epoch-ms is a fine, sortable heartbeat
    // value. Stored as the `heartbeat` memory insight.
    format!("{}", now_ms())
}

/// Resolve the effective interval, applying the default + floor.
fn resolve_interval(interval_secs: Option<u64>) -> u64 {
    match interval_secs {
        None => DEFAULT_INTERVAL_SECS,
        Some(s) => s.max(MIN_INTERVAL_SECS),
    }
}

/// Deterministic off-minute jitter in `0..=JITTER_MAX_SECS`. Pure so its
/// bounds are unit-testable; derived from nanos to avoid an rng dependency.
fn jitter_secs(now_nanos: u32) -> u64 {
    (now_nanos as u64) % (JITTER_MAX_SECS + 1)
}

// ---- bd arg builders (pure, unit-tested) ----

fn heartbeat_args(ts: &str) -> Vec<String> {
    vec![
        "remember".into(),
        ts.into(),
        "--key".into(),
        "heartbeat".into(),
        "--actor".into(),
        bd::ACTOR.into(),
    ]
}

fn defer_args(id: &str) -> Vec<String> {
    vec!["defer".into(), id.into()]
}

fn note_args(id: &str, note: &str) -> Vec<String> {
    vec!["note".into(), id.into(), note.into(), "--actor".into(), bd::ACTOR.into()]
}

/// The pulse prompt: a single autonomous heartbeat that advances exactly one
/// molecule step. Encodes idempotency ("ONE step", "next pulse resumes") so a
/// killed mid-step pulse is safe.
fn build_prompt(primer: &str, id: &str, title: &str, description: &str) -> String {
    format!(
        "<system-reminder>{primer}</system-reminder>\n\
You are the Beads Station conductor pulse — a single autonomous heartbeat.\n\
Do exactly ONE unit of work against bd, then exit.\n\n\
Target bead: {id} — {title}\n\
{description}\n\n\
Instructions:\n\
1. Context is already loaded above (bd prime).\n\
2. Find this bead's molecule and its single ready step:\n\
   `bd mol show {id} --parallel` (or locate the molecule this bead belongs to).\n\
3. Work that ONE ready step, then close it: `bd close <step-id>`.\n\
   Closing the step unblocks the next one — do NOT skip ahead, and do NOT\n\
   close the whole bead unless the molecule is fully complete.\n\
4. Record what you did: `bd note {id} \"<one line>\"`.\n\
5. If you cannot make progress, run `bd defer {id}` and stop. Do NOT fake progress.\n\
6. Exactly ONE step this pulse. Then stop — the next pulse resumes from bd state.\n\
bd holds the source of truth; if you are interrupted, the next pulse re-derives position."
    )
}

/// Run a bd verb through the shared semaphore, mapping failure to a logged
/// warning + `Err`. Thin helper so pulse steps read cleanly.
async fn bd_verb(repo: &str, args: &[String]) -> Result<Vec<u8>, String> {
    let slices: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    bd::run_bd_verb(repo, &slices).await
}

/// A single pulse. Best-effort: never panics, never fakes success. Every bd or
/// claude error is logged + surfaced via `conductor_status`.
async fn pulse(app: &AppHandle, repo: &str, dry_run: bool, interval_secs: u64) {
    let status = |state: &'static str, bead_id: Option<String>, detail: Option<String>| {
        emit_status(
            app,
            ConductorStatus {
                state,
                bead_id,
                detail,
                last_pulse_ms: Some(now_ms()),
                interval_secs,
                repo_path: repo.to_string(),
            },
        );
    };

    status("waking", None, None);

    // 1. bd prime — context for the pulse prompt. Non-fatal on error.
    let primer = match bd::bd_prime(repo.to_string()).await {
        Ok(text) => text,
        Err(e) => {
            tracing::warn!("conductor: bd prime failed: {e}");
            String::new()
        }
    };

    // 2. bd doctor health GATE. run_bd_verb collapses a non-zero exit to Err,
    //    which we treat as unhealthy: defer the top bead + notify, don't fake.
    if let Err(e) = bd_verb(repo, &["doctor".to_string()]).await {
        tracing::warn!("conductor: bd doctor unhealthy: {e}");
        // Try to defer the top ready bead (if any) so the loop makes no blind
        // progress; record the reason as a note.
        if let Ok(top) = bd::bd_ready(repo.to_string()).await {
            if let Some(bead) = top.into_iter().next() {
                let _ = bd_verb(repo, &defer_args(&bead.id)).await;
                let _ = bd_verb(
                    repo,
                    &note_args(&bead.id, "conductor: deferred — bd doctor unhealthy"),
                )
                .await;
                status("deferred", Some(bead.id), Some("bd doctor unhealthy".into()));
                return;
            }
        }
        status("deferred", None, Some("bd doctor unhealthy".into()));
        return;
    }

    // 3. bd ready — pick the top (priority-ordered) bead.
    let top = match bd::bd_ready(repo.to_string()).await {
        Ok(mut v) if !v.is_empty() => v.remove(0),
        Ok(_) => {
            status("idle", None, Some("no ready beads".into()));
            return;
        }
        Err(e) => {
            tracing::warn!("conductor: bd ready failed: {e}");
            status("error", None, Some(format!("bd ready: {e}")));
            return;
        }
    };

    // 4. One-shot claude run that advances one molecule step.
    let prompt = build_prompt(
        &primer,
        &top.id,
        &top.title,
        top.description.as_deref().unwrap_or(""),
    );
    let mode = if dry_run { "plan" } else { "acceptEdits" };
    if let Err(e) = run_pulse_claude(repo, &prompt, mode).await {
        tracing::warn!("conductor: claude pulse failed: {e}");
        status("error", Some(top.id.clone()), Some(format!("claude: {e}")));
        return;
    }

    // 5. Heartbeat — record last completed pulse. Non-fatal on error.
    if let Err(e) = bd_verb(repo, &heartbeat_args(&now_rfc3339_ish())).await {
        tracing::warn!("conductor: heartbeat failed: {e}");
    }

    // 6. Awake.
    status("awake", Some(top.id), None);
}

/// Fire a single one-shot `claude -p` run (owned output, reaped by `.output()`).
/// Reuses claude.rs's binary resolution + augmented PATH + ANTHROPIC env
/// forwarding, but NOT its persistent stream-json session shape.
async fn run_pulse_claude(repo: &str, prompt: &str, permission_mode: &str) -> Result<(), String> {
    let claude_path =
        binresolve::resolve_bin_or_default("claude", claude::CLAUDE_BIN_FALLBACK)?;
    let mut cmd = tokio::process::Command::new(&claude_path);
    cmd.current_dir(repo)
        .arg("-p")
        .arg(prompt)
        .arg("--model")
        .arg(PULSE_MODEL)
        .arg("--permission-mode")
        .arg(permission_mode)
        .env("PATH", claude::augmented_path());

    // Forward Anthropic creds the same way claude_start does; only vars that
    // are actually set, so we never clobber the child with empty strings.
    for var in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
    ] {
        if let Ok(val) = std::env::var(var) {
            if !val.is_empty() {
                cmd.env(var, val);
            }
        }
    }

    let output = tokio::time::timeout(PULSE_TIMEOUT, cmd.output())
        .await
        .map_err(|_| format!("claude pulse timed out after {}s", PULSE_TIMEOUT.as_secs()))?
        .map_err(|e| format!("failed to spawn claude: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "claude exited with {}: {}",
            output.status,
            stderr.trim()
        ));
    }
    Ok(())
}

/// Start the conductor for `repo_path`. Idempotent for the same repo; starting
/// a different repo replaces the running conductor. Default OFF: this is only
/// called on an explicit user action, never from lib.rs::setup.
#[tauri::command]
pub async fn conductor_start(
    app: AppHandle,
    interval_secs: Option<u64>,
    repo_path: String,
    dry_run: Option<bool>,
) -> Result<(), String> {
    let interval = resolve_interval(interval_secs);
    let dry = dry_run.unwrap_or(true);

    // Idempotent fast path + replace-on-different-repo. Take the old stop
    // handle out of the lock before notifying (never hold the guard across the
    // notify, though notify_waiters itself doesn't await).
    let old_stop = {
        let mut guard = CONDUCTOR.lock().map_err(|e| format!("conductor lock: {e}"))?;
        if let Some(s) = guard.as_ref() {
            if s.repo_path == repo_path {
                return Ok(());
            }
        }
        let old = guard.take().map(|s| s.stop);
        let stop = Arc::new(tokio::sync::Notify::new());
        *guard = Some(ConductorState {
            repo_path: repo_path.clone(),
            interval_secs: interval,
            stop: stop.clone(),
        });
        (old, stop)
    };
    if let Some(old) = old_stop.0 {
        old.notify_waiters();
    }
    let stop = old_stop.1;

    let app_task = app.clone();
    let repo_task = repo_path.clone();
    // tauri::async_runtime::spawn — a command runs on the tauri runtime, but we
    // keep the wrapper for consistency with telemetry.rs and to be safe if this
    // is ever called from a non-runtime context.
    tauri::async_runtime::spawn(async move {
        // One-time off-minute jitter shifts the whole cadence off boundaries.
        let jitter = jitter_secs(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0),
        );
        tokio::time::sleep(Duration::from_secs(jitter)).await;

        let mut tick = tokio::time::interval(Duration::from_secs(interval));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = stop.notified() => break,
                _ = tick.tick() => {
                    pulse(&app_task, &repo_task, dry, interval).await;
                }
            }
        }
    });

    Ok(())
}

/// Stop the conductor. Halts the schedule at the next loop boundary; any
/// in-flight pulse runs to completion (its step is durable in bd). Idempotent.
#[tauri::command]
pub async fn conductor_stop(app: AppHandle) -> Result<(), String> {
    let taken = {
        let mut guard = CONDUCTOR.lock().map_err(|e| format!("conductor lock: {e}"))?;
        guard.take()
    };
    if let Some(state) = taken {
        state.stop.notify_waiters();
        emit_status(
            &app,
            ConductorStatus {
                state: "stopped",
                bead_id: None,
                detail: None,
                last_pulse_ms: Some(now_ms()),
                interval_secs: state.interval_secs,
                repo_path: state.repo_path,
            },
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_interval_defaults_and_floors() {
        assert_eq!(resolve_interval(None), DEFAULT_INTERVAL_SECS);
        assert_eq!(resolve_interval(Some(0)), MIN_INTERVAL_SECS);
        assert_eq!(resolve_interval(Some(5)), MIN_INTERVAL_SECS);
        assert_eq!(resolve_interval(Some(60)), 60);
        assert_eq!(resolve_interval(Some(3600)), 3600);
    }

    #[test]
    fn jitter_is_bounded() {
        for n in [0u32, 1, 45, 46, 999_999, u32::MAX] {
            let j = jitter_secs(n);
            assert!(j <= JITTER_MAX_SECS, "jitter {j} out of bounds for {n}");
        }
    }

    #[test]
    fn heartbeat_args_shape() {
        assert_eq!(
            heartbeat_args("123"),
            vec!["remember", "123", "--key", "heartbeat", "--actor", "Beads Station"]
        );
    }

    #[test]
    fn defer_args_shape() {
        assert_eq!(defer_args("Code-abc"), vec!["defer", "Code-abc"]);
    }

    #[test]
    fn prompt_locks_the_safety_contract() {
        let p = build_prompt("PRIMER", "Code-xyz", "Do a thing", "the description");
        assert!(p.contains("Code-xyz"));
        assert!(p.contains("PRIMER"));
        assert!(p.contains("ONE step") || p.contains("ONE unit of work"));
        assert!(p.contains("next pulse resumes") || p.contains("next pulse re-derives"));
        assert!(p.contains("Do NOT fake progress"));
    }
}
