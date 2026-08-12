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
/// RV4.2 — max concurrent builder pulses fanned out across an epic's swarm in
/// a single tick. Bounded so a wide epic can't spawn an unbounded claude burst
/// (each builder is a full claude run); excess ready children wait for the next
/// tick. Kept small — the BD_SEMAPHORE (3) already serializes the bd verbs the
/// builders share, and merge-slot serializes their conflicting writes.
const MAX_FANOUT: usize = 3;

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

/// RV4.2 builder prompt: one parallel worker inside an epic's swarm. Same
/// one-step idempotency contract as the single pulse, PLUS the merge-slot
/// discipline — a builder MUST acquire the shared `<prefix>-merge-slot` before
/// any edit that could conflict, and release it after. This is bd's OWN
/// serialization primitive (`bd merge-slot`), not a lock we invented: the Rust
/// side never locks, it only tells each builder to cooperate through bd.
fn build_builder_prompt(primer: &str, epic_id: &str, id: &str, title: &str) -> String {
    format!(
        "<system-reminder>{primer}</system-reminder>\n\
You are ONE builder in the Beads Station conductor swarm for epic {epic_id}.\n\
You own exactly one child bead; other builders run in parallel on sibling beads.\n\n\
Your bead: {id} — {title}\n\n\
Instructions:\n\
1. Context is already loaded above (bd prime).\n\
2. Work ONE ready step of your bead's molecule, then close that step: `bd close <step-id>`.\n\
3. BEFORE any edit that could touch a file another builder might touch, acquire\n\
   the shared merge slot: `bd merge-slot acquire`. Do the edit. Then\n\
   `bd merge-slot release`. Never hold the slot across unrelated work — this is\n\
   how sibling builders avoid clobbering each other. If the slot is held, wait\n\
   your turn (bd queues you); do NOT bypass it.\n\
4. Record what you did: `bd note {id} \"<one line>\"`.\n\
5. If you cannot make progress, run `bd defer {id}` and stop. Do NOT fake progress.\n\
6. Exactly ONE step this pulse, on YOUR bead only. Do NOT touch sibling beads.\n\
bd holds the source of truth; a killed builder costs one retried step, next pulse resumes."
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
    //    RV4.2: if the top bead is an EPIC, fan out N parallel builders across
    //    its swarm's ready children instead of running a single builder. Each
    //    builder serializes conflicting writes through `bd merge-slot`.
    if top.issue_type == "epic" {
        fanout_pulse(app, repo, dry_run, interval_secs, &top, &primer).await;
        return;
    }

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

/// RV4.2 — epic fanout. Ensures a swarm molecule exists for the epic, reads its
/// ready children via `bd swarm status`, and spawns up to `MAX_FANOUT` builder
/// pulses concurrently. Each builder cooperates through `bd merge-slot` (bd's
/// own serialization primitive) — the conductor invents no locking of its own.
///
/// Best-effort + idempotent like the single pulse: a builder that dies costs at
/// most one retried step, and the next tick re-derives the ready set from bd.
/// Emits `awake` with a detail summarizing how many builders ran, `idle` when
/// the epic has no ready children this tick.
async fn fanout_pulse(
    app: &AppHandle,
    repo: &str,
    dry_run: bool,
    interval_secs: u64,
    epic: &bd::Issue,
    primer: &str,
) {
    let emit = |state: &'static str, detail: Option<String>| {
        emit_status(
            app,
            ConductorStatus {
                state,
                bead_id: Some(epic.id.clone()),
                detail,
                last_pulse_ms: Some(now_ms()),
                interval_secs,
                repo_path: repo.to_string(),
            },
        );
    };

    // Ensure the swarm molecule exists (best-effort — status is computed from
    // beads regardless, so a create failure on an existing swarm is harmless).
    let _ = bd::swarm_create(repo, &epic.id).await;

    let swarm = match bd::swarm_status(repo, &epic.id).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("conductor: swarm status failed for {}: {e}", epic.id);
            emit("error", Some(format!("swarm status: {e}")));
            return;
        }
    };

    // Ready children only, capped. bd's swarm status already excludes
    // in_progress/blocked and emits `ready` in its own (priority) order; we
    // preserve that order and take the top MAX_FANOUT so a wide epic doesn't
    // spawn an unbounded claude burst. The remaining ready children are not
    // dropped — they run on subsequent ticks (bd re-derives the ready set each
    // tick), so nothing starves; the batch is just this tick's slice.
    let batch: Vec<bd::SwarmNode> = swarm.ready.into_iter().take(MAX_FANOUT).collect();
    if batch.is_empty() {
        emit("idle", Some(format!("epic {} has no ready children", epic.id)));
        return;
    }

    let mode = if dry_run { "plan" } else { "acceptEdits" };
    let n = batch.len();
    emit("waking", Some(format!("fanning out {n} builder(s) for {}", epic.id)));

    // Spawn all builders concurrently; each is a full claude run. join_all waits
    // for the whole batch so the tick doesn't overlap the next (PULSE_TIMEOUT
    // bounds each). Merge-slot serialization happens INSIDE the builders (in bd),
    // not here — the Rust side only fans out.
    let mut handles = Vec::with_capacity(n);
    for child in batch {
        let prompt = build_builder_prompt(primer, &epic.id, &child.id, &child.title);
        let repo_owned = repo.to_string();
        let mode_owned = mode.to_string();
        handles.push(async move {
            let r = run_pulse_claude(&repo_owned, &prompt, &mode_owned).await;
            (child.id, r)
        });
    }
    let results = futures_join_all(handles).await;

    // Each result carries its own bead id (the id rides INSIDE the tuple, not by
    // positional index) so a dropped task never mislabels a survivor. `lost` =
    // builders whose task vanished before returning (a join error — near-
    // impossible since run_pulse_claude never panics, but counted honestly so
    // ok+failed+lost always == n and the status line can't silently undercount).
    let mut ok = 0usize;
    let mut failed: Vec<String> = Vec::new();
    for (id, r) in &results {
        match r {
            Ok(()) => ok += 1,
            Err(e) => {
                tracing::warn!("conductor: builder {id} failed: {e}");
                failed.push(id.clone());
            }
        }
    }
    let lost = n.saturating_sub(results.len());

    // Heartbeat once for the whole fanout tick. Non-fatal on error.
    if let Err(e) = bd_verb(repo, &heartbeat_args(&now_rfc3339_ish())).await {
        tracing::warn!("conductor: heartbeat failed: {e}");
    }

    if failed.is_empty() && lost == 0 {
        emit("awake", Some(format!("{ok} builder(s) advanced for {}", epic.id)));
    } else {
        emit(
            "error",
            Some(format!(
                "{ok} ok, {} failed ({}){}",
                failed.len(),
                failed.join(","),
                if lost > 0 { format!(", {lost} lost") } else { String::new() }
            )),
        );
    }
}

/// Minimal concurrent-join over a set of futures without pulling the `futures`
/// crate: spawn each on the tauri runtime and await the handles in order. Order
/// of the returned Vec matches input order. A join error (task panic) maps to
/// the future's own Err path via the closures above returning owned results, so
/// this only needs to surface the JoinHandle result.
async fn futures_join_all<F, T>(futs: Vec<F>) -> Vec<T>
where
    F: std::future::Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    let handles: Vec<_> = futs
        .into_iter()
        .map(tauri::async_runtime::spawn)
        .collect();
    let mut out = Vec::with_capacity(handles.len());
    for h in handles {
        match h.await {
            Ok(v) => out.push(v),
            Err(e) => {
                // A spawned builder task panicked/aborted. We can't reconstruct
                // T, so this is unreachable in practice (run_pulse_claude never
                // panics), but we must not unwrap. Log + skip.
                tracing::error!("conductor: builder task join error: {e}");
            }
        }
    }
    out
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

    #[test]
    fn builder_prompt_locks_merge_slot_contract() {
        // RV4.2 — a builder MUST be told to serialize through bd merge-slot and
        // stay on its own bead. Pin those clauses so a prompt edit can't quietly
        // drop the "no monkey knife fights" discipline.
        let p = build_builder_prompt("PRIMER", "Code-epic", "Code-child", "Child title");
        assert!(p.contains("Code-epic"));
        assert!(p.contains("Code-child"));
        assert!(p.contains("bd merge-slot acquire"));
        assert!(p.contains("bd merge-slot release"));
        assert!(p.contains("do NOT bypass it") || p.contains("do NOT bypass"));
        assert!(p.contains("Do NOT touch sibling beads"));
        assert!(p.contains("Do NOT fake progress"));
        assert!(p.contains("ONE step"));
    }

    #[test]
    fn fanout_cap_is_bounded() {
        // The batch is `ready.take(MAX_FANOUT)` — assert the cap is a small,
        // positive bound so a wide epic never spawns an unbounded claude burst.
        assert!(MAX_FANOUT >= 1 && MAX_FANOUT <= 8, "MAX_FANOUT {MAX_FANOUT} out of sane range");
    }
}
