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

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::bd;
use crate::binresolve;
use crate::claude;
use crate::herdr_bridge;

/// Default pulse cadence: 20 minutes.
const DEFAULT_INTERVAL_SECS: u64 = 1200;
/// Floor so a `0`/tiny interval can't busy-spin claude.
const MIN_INTERVAL_SECS: u64 = 10;
/// Off-minute jitter ceiling (a one-time pre-loop offset).
const JITTER_MAX_SECS: u64 = 45;
/// Hard cap on a single pulse. Kept well under the default interval so ticks
/// never overlap (paired with MissedTickBehavior::Skip).
const PULSE_TIMEOUT: Duration = Duration::from_secs(600);
// ---- RV4.3: token tiers (size -> model) ----

/// Model tier for the WORK a pulse performs, chosen from a bead's size. The
/// pulse ORCHESTRATION (prime/doctor/ready in Rust) costs nothing extra; this
/// is the model claude uses for the actual build/review step, escalating cost
/// only with the work's size. Unlabeled beads default to [S] (Haiku) — the
/// cheap-by-default posture (safety principle #4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tier {
    /// [S] — cheap, auto-proceed, light review. Also the default when a bead
    /// carries no size label (cheap-by-default, safety principle #4).
    Small,
    /// [M] — mid model, one review, gate if the work touches shared files.
    Medium,
    /// [L] — top model, plan-first + adversarial, mandatory gate before+after.
    Large,
}

const MODEL_SMALL: &str = "claude-haiku-4-5-20251001";
const MODEL_MEDIUM: &str = "claude-sonnet-5";
const MODEL_LARGE: &str = "claude-opus-5";

impl Tier {
    fn model(self) -> &'static str {
        match self {
            Tier::Small => MODEL_SMALL,
            Tier::Medium => MODEL_MEDIUM,
            Tier::Large => MODEL_LARGE,
        }
    }

    /// One-line ceremony descriptor relayed into the work prompt so claude runs
    /// the right rigor. Mirrors the formula's declarative ceremony.
    fn ceremony(self) -> &'static str {
        match self {
            Tier::Small => "light review, auto-proceed",
            Tier::Medium => "one review pass; gate if the change touches shared files",
            Tier::Large => "plan first, adversarial self-review, MANDATORY human gate before and after",
        }
    }

    fn tag(self) -> &'static str {
        match self {
            Tier::Small => "S",
            Tier::Medium => "M",
            Tier::Large => "L",
        }
    }
}

/// DU3 (Code-d7j) — the operator's default tier ceiling, set by the Designer-UI
/// Everyday/Heavy toggle. This is the tier a bead gets when it carries NO size
/// label; a per-bead `size:`/`model:` label still wins over it (safety
/// principle: explicit-per-bead beats global default). Default `Small`
/// preserves the pre-DU3 cheap-by-default posture until an operator opts in.
///
///   Everyday -> Medium (Sonnet)  ·  Heavy -> Large (Opus/xhigh)
///
/// Stored as an atomic so the tokio pulse loop reads it without a lock. Set via
/// the `conductor_set_default_tier` command; the running loop picks up the new
/// floor on its next tick (no restart needed).
static DEFAULT_TIER: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

impl Tier {
    fn from_u8(v: u8) -> Tier {
        match v {
            1 => Tier::Medium,
            2 => Tier::Large,
            _ => Tier::Small,
        }
    }
    fn as_u8(self) -> u8 {
        match self {
            Tier::Small => 0,
            Tier::Medium => 1,
            Tier::Large => 2,
        }
    }
}

/// The current operator default tier (loaded from DEFAULT_TIER).
fn default_tier() -> Tier {
    Tier::from_u8(DEFAULT_TIER.load(std::sync::atomic::Ordering::Relaxed))
}

/// Resolve the work tier from a bead's labels. Precedence:
///   1. An explicit `model:<name>` label — per-bead override wins outright
///      (returns None for the tier but Some(model) so the caller uses it raw).
///   2. A size label `size:S|M|L` (or the short `sz:` / bare `[S]`-style
///      `size-l`) → the matching tier.
///   3. No size hint → the operator's DEFAULT_TIER floor (DU3 Everyday/Heavy
///      toggle; itself defaults to Small = cheap-by-default).
/// Returns (tier, explicit_model_override). `explicit_model_override` is
/// `Some(name)` only for case 1; otherwise `None` and the tier's model is used.
fn resolve_tier(labels: &[String]) -> (Tier, Option<String>) {
    let mut override_model: Option<String> = None;
    let mut tier: Option<Tier> = None;
    for raw in labels {
        let l = raw.trim().to_ascii_lowercase();
        if let Some(m) = l.strip_prefix("model:") {
            if !m.is_empty() {
                override_model = Some(m.to_string());
            }
        } else if let Some(sz) = l
            .strip_prefix("size:")
            .or_else(|| l.strip_prefix("sz:"))
            .or_else(|| l.strip_prefix("size-"))
        {
            tier = Some(match sz {
                "s" | "small" => Tier::Small,
                "m" | "medium" | "med" => Tier::Medium,
                "l" | "large" | "xl" => Tier::Large,
                _ => tier.unwrap_or_else(default_tier),
            });
        }
    }
    // No explicit size label -> fall to the operator default tier.
    (tier.unwrap_or_else(default_tier), override_model)
}

/// RV4.2 — max concurrent builder pulses fanned out across an epic's swarm in
/// a single tick. Bounded so a wide epic can't spawn an unbounded claude burst
/// (each builder is a full claude run); excess ready children wait for the next
/// tick. Kept small — the BD_SEMAPHORE (3) already serializes the bd verbs the
/// builders share, and merge-slot serializes their conflicting writes.
const MAX_FANOUT: usize = 3;

struct ConductorState {
    repo_path: String,
    interval_secs: u64,
    /// The loop's posture. Code-jx3.2: an on-demand `conductor_pulse_now` for the
    /// same repo INHERITS this so a dry-run loop can't be turned into a live
    /// `acceptEdits` one-shot from the UI (keeps the RV5.0 gate invariant airtight).
    dry_run: bool,
    /// RV7.2: when true, pulse delegates to herdr instead of spawning a subprocess.
    /// Auto-enabled if HERDR_SOCKET_PATH is set at conductor_start time. Keeps the
    /// in-process path alive as the fallback so the app runs identically without herdr.
    herdr_mode: bool,
    stop: Arc<tokio::sync::Notify>,
}

static CONDUCTOR: Lazy<Mutex<Option<ConductorState>>> = Lazy::new(|| Mutex::new(None));

// Code-jx3.3 (RV6.3) — per-builder cancel registry. A fanout tick registers one
// cancel `Notify` per in-flight builder keyed by its bead id; `conductor_stop_agent`
// fires the matching `Notify`, and the builder's `tokio::select!` bails + kills its
// claude child (kill_on_drop). The registry is the ONLY shared cancel surface — the
// Rust side still invents no locking beyond this bookkeeping; bd remains the source
// of truth, and an aborted builder's in-flight step is durable (next tick re-derives).
static IN_FLIGHT: Lazy<Mutex<HashMap<String, Arc<tokio::sync::Notify>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Register a cancel handle for an in-flight builder. Returns the `Notify` the
/// builder selects on. Overwrites any stale entry for the same bead (a prior tick's
/// builder that never deregistered) — the newest in-flight builder owns the key.
fn register_in_flight(bead_id: &str) -> Arc<tokio::sync::Notify> {
    let notify = Arc::new(tokio::sync::Notify::new());
    if let Ok(mut map) = IN_FLIGHT.lock() {
        map.insert(bead_id.to_string(), notify.clone());
    }
    notify
}

/// Remove a builder's cancel handle once it finishes (success, failure, or cancel).
fn deregister_in_flight(bead_id: &str) {
    if let Ok(mut map) = IN_FLIGHT.lock() {
        map.remove(bead_id);
    }
}

/// Look up + remove a builder's cancel handle. `Some` means a builder was in flight
/// and is now told to stop; `None` means nothing was running for that bead.
fn take_in_flight(bead_id: &str) -> Option<Arc<tokio::sync::Notify>> {
    IN_FLIGHT.lock().ok()?.remove(bead_id)
}

/// App-global status event (un-namespaced, telemetry idiom). Drives the
/// Designer-UI "Claude is awake" footer + the DU3 active-agents panel.
///
/// `state` wire contract: "waking" | "awake" | "idle" | "deferred" | "error"
/// | "stopped" | "blocked".
/// RV7.2: `agent_status` carries the herdr AgentStatus when herdr_mode is on,
/// enabling the ActiveAgents panel to surface "blocked" (agent needs gate input).
#[derive(Serialize, Clone)]
pub struct ConductorStatus {
    pub state: &'static str,
    pub bead_id: Option<String>,
    pub detail: Option<String>,
    pub last_pulse_ms: Option<u128>,
    pub interval_secs: u64,
    pub repo_path: String,
    /// RV7.2: herdr agent status (idle/working/blocked/done/unknown). None when
    /// herdr_mode is off or the status has not yet been observed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_status: Option<String>,
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
/// killed mid-step pulse is safe. RV4.3: `tier_tag` + `ceremony` relay the
/// size tier's rigor (declarative in the formula; echoed here so the work run
/// applies the right review depth).
fn build_prompt(
    primer: &str,
    id: &str,
    title: &str,
    description: &str,
    tier_tag: &str,
    ceremony: &str,
) -> String {
    format!(
        "<system-reminder>{primer}</system-reminder>\n\
You are the Beads Station conductor pulse — a single autonomous heartbeat.\n\
Do exactly ONE unit of work against bd, then exit.\n\n\
Target bead: {id} — {title}\n\
{description}\n\n\
Size tier: [{tier_tag}] — {ceremony}.\n\n\
Instructions:\n\
1. Context is already loaded above (bd prime).\n\
2. Find this bead's molecule and its single ready step:\n\
   `bd mol show {id} --parallel` (or locate the molecule this bead belongs to).\n\
3. Work that ONE ready step at the [{tier_tag}] ceremony above, then close it:\n\
   `bd close <step-id>`. Closing the step unblocks the next one — do NOT skip\n\
   ahead, and do NOT close the whole bead unless the molecule is fully complete.\n\
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
fn build_builder_prompt(
    primer: &str,
    epic_id: &str,
    id: &str,
    title: &str,
    tier_tag: &str,
    ceremony: &str,
) -> String {
    format!(
        "<system-reminder>{primer}</system-reminder>\n\
You are ONE builder in the Beads Station conductor swarm for epic {epic_id}.\n\
You own exactly one child bead; other builders run in parallel on sibling beads.\n\n\
Your bead: {id} — {title}\n\
Size tier: [{tier_tag}] — {ceremony}.\n\n\
Instructions:\n\
1. Context is already loaded above (bd prime).\n\
2. Work ONE ready step of your bead's molecule at the [{tier_tag}] ceremony\n\
   above, then close that step: `bd close <step-id>`.\n\
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
async fn pulse(app: &AppHandle, repo: &str, dry_run: bool, interval_secs: u64, herdr_mode: bool) {
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
                agent_status: None,
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

    // 4+. Advance exactly this bead (fanout if it's an epic). Shared with the
    //     on-demand `conductor_pulse_now` path (Code-jx3.2) so a triggered pulse
    //     runs the SAME gated body as an interval pulse — no second code path.
    pulse_bead(app, repo, dry_run, interval_secs, herdr_mode, &top, &primer).await;
}

/// Code-jx3.2 (RV6.2) — advance ONE already-resolved bead: fan out if it's an
/// epic, else run a single tier-resolved builder pulse, then heartbeat + emit
/// `awake`. Extracted verbatim from the tail of `pulse()` so the interval loop and
/// the on-demand `conductor_pulse_now` command share one gated body. `primer` is
/// the pre-loaded bd-prime context; `interval_secs` only labels the status event.
async fn pulse_bead(
    app: &AppHandle,
    repo: &str,
    dry_run: bool,
    interval_secs: u64,
    herdr_mode: bool,
    top: &bd::Issue,
    primer: &str,
) {
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
                agent_status: None,
            },
        );
    };

    // If the top bead is an EPIC, fan out N parallel builders across its swarm's
    // ready children instead of running a single builder. Each builder serializes
    // conflicting writes through `bd merge-slot`.
    if top.issue_type == "epic" {
        fanout_pulse(app, repo, dry_run, interval_secs, herdr_mode, top, primer).await;
        return;
    }

    // RV4.3: pick the WORK model from the bead's size tier. The pulse
    // orchestration is Haiku; the work escalates only with size. A `model:`
    // label overrides the tier outright (per-bead override wins).
    let labels = top.labels.clone().unwrap_or_default();
    let (tier, override_model) = resolve_tier(&labels);
    let work_model = override_model.as_deref().unwrap_or_else(|| tier.model());

    let prompt = build_prompt(
        primer,
        &top.id,
        &top.title,
        top.description.as_deref().unwrap_or(""),
        tier.tag(),
        tier.ceremony(),
    );
    let mode = if dry_run { "plan" } else { "acceptEdits" };
    let outcome = match run_pulse_claude(repo, &prompt, mode, work_model, None, herdr_mode).await {
        Ok(o) => o,
        Err(e) => {
            tracing::warn!("conductor: claude pulse failed: {e}");
            status("error", Some(top.id.clone()), Some(format!("claude: {e}")));
            return;
        }
    };

    // Heartbeat — record last completed pulse. Non-fatal on error.
    if let Err(e) = bd_verb(repo, &heartbeat_args(&now_rfc3339_ish())).await {
        tracing::warn!("conductor: heartbeat failed: {e}");
    }

    // RV7.3: a Blocked outcome (herdr agent waiting on gate input) emits a
    // `blocked` status with agent_status set, so the ActiveAgents panel can show
    // the pane needs the operator. A Completed outcome is the ordinary `awake`.
    match outcome {
        PulseOutcome::Blocked => emit_status(
            app,
            ConductorStatus {
                state: "blocked",
                bead_id: Some(top.id.clone()),
                detail: Some("agent blocked — needs gate input".to_string()),
                last_pulse_ms: Some(now_ms()),
                interval_secs,
                repo_path: repo.to_string(),
                agent_status: outcome.agent_status(),
            },
        ),
        PulseOutcome::Completed => status("awake", Some(top.id.clone()), None),
    }
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
    herdr_mode: bool,
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
                agent_status: None,
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
        // RV4.3: resolve each child's work tier from its own labels (a `bd show`
        // read, semaphore-bounded). Fanout children default to [S] like any
        // unlabeled bead; a `size:`/`model:` label on the child escalates it.
        let (tier, override_model) = match bd::bd_show(repo.to_string(), child.id.clone()).await {
            Ok(issue) => resolve_tier(&issue.labels.unwrap_or_default()),
            Err(e) => {
                tracing::warn!("conductor: bd show {} for tier failed: {e}; defaulting [S]", child.id);
                (Tier::Small, None)
            }
        };
        let work_model = override_model.unwrap_or_else(|| tier.model().to_string());
        let prompt =
            build_builder_prompt(primer, &epic.id, &child.id, &child.title, tier.tag(), tier.ceremony());
        let repo_owned = repo.to_string();
        let mode_owned = mode.to_string();
        // Code-jx3.3: register a cancel handle so `conductor_stop_agent(child.id)`
        // can stop just this builder. Deregister on completion (ok/err/cancel) so a
        // stale handle never lingers past the tick.
        let cancel = register_in_flight(&child.id);
        handles.push(async move {
            let r = run_pulse_claude(&repo_owned, &prompt, &mode_owned, &work_model, Some(&cancel), herdr_mode).await;
            deregister_in_flight(&child.id);
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
    let mut blocked: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    for (id, r) in &results {
        match r {
            Ok(PulseOutcome::Completed) => ok += 1,
            // RV7.3: a blocked builder ran its step but is waiting on gate input.
            // Counted apart from ok/failed so the aggregate can surface it.
            Ok(PulseOutcome::Blocked) => blocked.push(id.clone()),
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
        // RV7.3: if any builder is blocked (herdr gate wait), report `blocked`
        // with agent_status so the panel flags the epic as needing input; the
        // completed builders are still counted in the detail.
        if blocked.is_empty() {
            emit("awake", Some(format!("{ok} builder(s) advanced for {}", epic.id)));
        } else {
            emit_status(
                app,
                ConductorStatus {
                    state: "blocked",
                    bead_id: Some(epic.id.clone()),
                    detail: Some(format!(
                        "{ok} advanced, {} blocked ({}) for {}",
                        blocked.len(),
                        blocked.join(","),
                        epic.id
                    )),
                    last_pulse_ms: Some(now_ms()),
                    interval_secs,
                    repo_path: repo.to_string(),
                    agent_status: Some("blocked".to_string()),
                },
            );
        }
    } else {
        emit(
            "error",
            Some(format!(
                "{ok} ok, {} failed ({}){}{}",
                failed.len(),
                failed.join(","),
                if !blocked.is_empty() {
                    format!(", {} blocked", blocked.len())
                } else {
                    String::new()
                },
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
/// forwarding, but NOT its persistent stream-json session shape. `model` is the
/// RV4.3 size-tier work model (MODEL_SMALL/Haiku for [S]/default; escalates for [M]/[L]).
///
/// Code-jx3.3: `cancel` is an optional per-builder stop signal. When it fires
/// mid-run the child claude is killed (kill_on_drop) and the call returns the
/// `cancelled` marker Err. The single-pulse path passes `None`; fanout builders
/// pass their registered `Notify`. The in-flight bd step is durable regardless —
/// a cancelled builder costs at most one retried step (same idempotency contract).
/// RV7.3: terminal state of a single pulse. The subprocess path always resolves
/// to `Completed` (a subprocess exit is a completion); the herdr path can also
/// resolve to `Blocked` when the agent stops on `until:[blocked]` waiting for
/// gate input. Maps to the `ConductorStatus.agent_status` wire field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PulseOutcome {
    Completed,
    Blocked,
}

impl PulseOutcome {
    /// The `agent_status` wire string for this outcome, or None for a plain
    /// completion (the FE treats a missing agent_status as "not herdr / not
    /// blocked" and renders the ordinary `awake` card).
    fn agent_status(self) -> Option<String> {
        match self {
            PulseOutcome::Blocked => Some("blocked".to_string()),
            PulseOutcome::Completed => None,
        }
    }
}

///
/// `pulse_bead`/`fanout_pulse` can distinguish an agent that COMPLETED from one
/// that BLOCKED (needs gate input). Without this the herdr Blocked transition —
/// the whole reason RV7 waits on `until:[blocked,done]` — was silently reported
/// as `awake`, so the operator never saw that an agent was waiting on them.
async fn run_pulse_claude(
    repo: &str,
    prompt: &str,
    permission_mode: &str,
    model: &str,
    cancel: Option<&tokio::sync::Notify>,
    herdr_mode: bool,
) -> Result<PulseOutcome, String> {
    if herdr_mode {
        return run_pulse_via_herdr(repo, prompt, permission_mode, model, cancel).await;
    }
    run_pulse_subprocess(repo, prompt, permission_mode, model, cancel).await
}

/// RV7.2 herdr path: start a claude pane via herdr, send the prompt, wait for
/// Blocked or Done. The pane lives in the herdr daemon — closing the Tauri window
/// does NOT kill it (that persistence is the point of RV7).
///
/// Strategy: split a new pane, start the claude agent, send the prompt with
/// wait={until:[blocked,done], timeout_ms: PULSE_TIMEOUT_MS}. On Blocked, record
/// the state for the UI and return Ok (the pulse step ran; next tick re-derives).
/// On Done, also return Ok. Any herdr error falls back with Err.
async fn run_pulse_via_herdr(
    repo: &str,
    prompt: &str,
    permission_mode: &str,
    model: &str,
    cancel: Option<&tokio::sync::Notify>,
) -> Result<PulseOutcome, String> {
    use herdr_bridge::{
        AgentStartParams, AgentStatus, AgentPromptParams, AgentPromptWaitOptions,
        PaneSplitParams, SplitDirection,
    };

    let pulse_timeout_ms: u64 = PULSE_TIMEOUT.as_millis() as u64;
    let pane_name = format!("conductor-{repo}");

    tracing::info!(
        "conductor: herdr pulse repo={repo} model={model} mode={permission_mode}"
    );

    // 1. Split a new pane for this pulse. cwd=repo so the claude process inherits
    //    the right working directory.
    let pane_id = herdr_bridge::pane_split(PaneSplitParams {
        direction: SplitDirection::Vertical,
        cwd: Some(repo.to_string()),
        workspace_id: None,
        focus: false,
    })
    .await
    .map_err(|e| format!("herdr pane.split: {e}"))?;

    // 2. Start a claude agent in the new pane. kind="claude" matches herdr's
    //    supported agent manifest.
    herdr_bridge::agent_start(AgentStartParams {
        name: pane_name.clone(),
        kind: "claude".to_string(),
        pane_id: pane_id.clone(),
        timeout_ms: Some(30_000),
        args: vec![
            "--permission-mode".to_string(),
            permission_mode.to_string(),
            "--model".to_string(),
            model.to_string(),
        ],
    })
    .await
    .map_err(|e| format!("herdr agent.start: {e}"))?;

    // 3. Send the prompt and wait for Blocked or Done. If the cancel signal fires
    //    first we still get Ok (the prompt was sent; the conductor treats cancel as
    //    a normal stop, same as the subprocess path).
    let prompt_future = herdr_bridge::agent_prompt(AgentPromptParams {
        target: pane_name.clone(),
        text: prompt.to_string(),
        wait: Some(AgentPromptWaitOptions {
            until: vec![AgentStatus::Blocked, AgentStatus::Done],
            timeout_ms: Some(pulse_timeout_ms),
        }),
    });

    let cancelled = async {
        match cancel {
            Some(n) => n.notified().await,
            None => std::future::pending::<()>().await,
        }
    };

    tokio::pin!(prompt_future);
    let status = tokio::select! {
        r = &mut prompt_future => r.map_err(|e| format!("herdr agent.prompt: {e}"))?,
        _ = cancelled => {
            tracing::info!("conductor: herdr pulse cancelled for {pane_name}");
            return Ok(PulseOutcome::Completed);
        }
    };

    tracing::info!("conductor: herdr pulse finished repo={repo} status={status}");
    // RV7.3: a Blocked terminal state means the agent is waiting on gate input;
    // surface it so the operator sees the pane needs them. Any other terminal
    // state (Done and the should-not-happen idle/working/unknown) is a completion.
    Ok(match status {
        AgentStatus::Blocked => PulseOutcome::Blocked,
        _ => PulseOutcome::Completed,
    })
}

/// Original subprocess path (fallback when herdr_mode=false).
async fn run_pulse_subprocess(
    repo: &str,
    prompt: &str,
    permission_mode: &str,
    model: &str,
    cancel: Option<&tokio::sync::Notify>,
) -> Result<PulseOutcome, String> {
    let claude_path =
        binresolve::resolve_bin_or_default("claude", claude::CLAUDE_BIN_FALLBACK)?;
    // Code-0vd (RV-live): surface the resolved work model + posture per pulse so
    // an operator toggling Everyday/Heavy can confirm the --model arg actually
    // changed. Prompt is elided (can be large / sensitive); repo + model + mode
    // are the verify-relevant facts.
    tracing::info!(
        "conductor: pulse spawn repo={repo} model={model} mode={permission_mode} bin={}",
        claude_path.display()
    );
    let mut cmd = tokio::process::Command::new(&claude_path);
    cmd.current_dir(repo)
        .arg("-p")
        .arg(prompt)
        .arg("--model")
        .arg(model)
        .arg("--permission-mode")
        .arg(permission_mode)
        // Code-jx3.3: kill the child if this future is dropped/aborted, so a
        // cancelled builder never leaves an orphan claude running.
        .kill_on_drop(true)
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

    // Spawn + reap the child, racing three arms: completion, PULSE_TIMEOUT, and
    // (if present) the per-builder cancel. Cancel/timeout drop the child future,
    // and kill_on_drop reaps the process — no orphan claude survives.
    let child = cmd.spawn().map_err(|e| format!("failed to spawn claude: {e}"))?;
    let output = {
        let wait = child.wait_with_output();
        tokio::pin!(wait);
        let cancelled = async {
            match cancel {
                Some(n) => n.notified().await,
                // No cancel signal: never resolve, so select falls to wait/timeout.
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            r = &mut wait => r.map_err(|e| format!("failed to spawn claude: {e}"))?,
            _ = tokio::time::sleep(PULSE_TIMEOUT) => {
                return Err(format!("claude pulse timed out after {}s", PULSE_TIMEOUT.as_secs()));
            }
            _ = cancelled => {
                return Err("cancelled".into());
            }
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "claude exited with {}: {}",
            output.status,
            stderr.trim()
        ));
    }
    // A subprocess exit is always a completion — the subprocess path has no
    // Blocked concept (that lives only in the herdr wait protocol).
    Ok(PulseOutcome::Completed)
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
        // RV7.2: auto-enable herdr_mode if the socket is available at start time.
        let herdr_mode = herdr_bridge::is_available();
        if herdr_mode {
            tracing::info!("conductor: herdr_mode enabled (HERDR_SOCKET_PATH detected)");
        }
        *guard = Some(ConductorState {
            repo_path: repo_path.clone(),
            interval_secs: interval,
            dry_run: dry,
            herdr_mode,
            stop: stop.clone(),
        });
        (old, stop, herdr_mode)
    };
    if let Some(old) = old_stop.0 {
        old.notify_waiters();
    }
    let stop = old_stop.1;
    let herdr_mode = old_stop.2;

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
                    pulse(&app_task, &repo_task, dry, interval, herdr_mode).await;
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
                agent_status: None,
            },
        );
    }
    Ok(())
}

/// Code-jx3.2 (RV6.2) — read a running conductor's posture for a repo, if one is
/// running for exactly that repo. Returns `(dry_run, interval_secs)`. `None` means
/// no conductor is running for this repo, so an on-demand pulse falls back to its
/// passed flag + the default interval. Pure over the CONDUCTOR lock, so the
/// inheritance rule is unit-testable without a runtime.
fn running_posture(repo: &str) -> Option<(bool, u64, bool)> {
    let guard = CONDUCTOR.lock().ok()?;
    let state = guard.as_ref()?;
    if state.repo_path == repo {
        Some((state.dry_run, state.interval_secs, state.herdr_mode))
    } else {
        None
    }
}

/// Code-jx3.2 (RV6.2) — fire ONE targeted pulse for `bead_id` on demand, bypassing
/// the interval wait but NOT the gate. Runs the SAME gated body as an interval
/// pulse (`pulse_bead`): bd prime + bd doctor health gate, then advance the bead
/// (fanout if it's an epic). Does NOT start/stop the loop — it's a one-shot.
///
/// Safety (locked): posture INHERITS a running loop's `dry_run` for this repo, so
/// a dry-run conductor can't be turned into a live `acceptEdits` one-shot from the
/// UI. If no conductor is running, the passed `dry_run` is honored (defaults true).
/// Either way the RV5.0 human gate stays authoritative for real edits.
#[tauri::command]
pub async fn conductor_pulse_now(
    app: AppHandle,
    repo_path: String,
    bead_id: String,
    dry_run: Option<bool>,
) -> Result<(), String> {
    // Posture: a running loop for THIS repo wins over the passed flag; else honor
    // the flag (default true = plan/dry-run), and label the status with the
    // default interval since no loop cadence applies.
    let (dry, interval, herdr_mode) = match running_posture(&repo_path) {
        Some((loop_dry, loop_interval, loop_herdr)) => (loop_dry, loop_interval, loop_herdr),
        None => (dry_run.unwrap_or(true), DEFAULT_INTERVAL_SECS, herdr_bridge::is_available()),
    };

    let emit = |state: &'static str, bead: Option<String>, detail: Option<String>| {
        emit_status(
            &app,
            ConductorStatus {
                state,
                bead_id: bead,
                detail,
                last_pulse_ms: Some(now_ms()),
                interval_secs: interval,
                repo_path: repo_path.clone(),
                agent_status: None,
            },
        );
    };

    emit("waking", Some(bead_id.clone()), Some("run now".into()));

    // bd prime — context for the pulse prompt. Non-fatal on error.
    let primer = match bd::bd_prime(repo_path.clone()).await {
        Ok(text) => text,
        Err(e) => {
            tracing::warn!("conductor: pulse_now bd prime failed: {e}");
            String::new()
        }
    };

    // bd doctor health GATE — same posture as the interval pulse. Unhealthy DB:
    // defer this bead + note the reason, never fake progress.
    if let Err(e) = bd_verb(&repo_path, &["doctor".to_string()]).await {
        tracing::warn!("conductor: pulse_now bd doctor unhealthy: {e}");
        let _ = bd_verb(&repo_path, &defer_args(&bead_id)).await;
        let _ = bd_verb(
            &repo_path,
            &note_args(&bead_id, "conductor: deferred — bd doctor unhealthy (run now)"),
        )
        .await;
        emit("deferred", Some(bead_id), Some("bd doctor unhealthy".into()));
        return Ok(());
    }

    // Resolve the targeted bead (carries labels for tier + epic detection).
    let issue = bd::bd_show(repo_path.clone(), bead_id.clone())
        .await
        .map_err(|e| format!("bd show {bead_id}: {e}"))?;

    pulse_bead(&app, &repo_path, dry, interval, herdr_mode, &issue, &primer).await;
    Ok(())
}

/// Code-jx3.3 (RV6.3) — stop ONE in-flight builder by bead id. Fires its
/// registered cancel `Notify`; the builder's `run_pulse_claude` bails and its
/// claude child is killed (kill_on_drop). No-op if nothing is running for that
/// bead. The gate stays authoritative: a stop only halts a dry-run/gated pulse
/// that was already in flight, and the in-flight bd step is durable (next tick
/// re-derives). Emits a `deferred` status so the feed shows the stop landed.
#[tauri::command]
pub async fn conductor_stop_agent(app: AppHandle, bead_id: String) -> Result<(), String> {
    match take_in_flight(&bead_id) {
        Some(cancel) => {
            cancel.notify_waiters();
            emit_status(
                &app,
                ConductorStatus {
                    state: "deferred",
                    bead_id: Some(bead_id),
                    detail: Some("stopped by operator".into()),
                    last_pulse_ms: Some(now_ms()),
                    interval_secs: DEFAULT_INTERVAL_SECS,
                    repo_path: String::new(),
                    agent_status: None,
                },
            );
            Ok(())
        }
        None => {
            // Nothing in flight for this bead — not an error (the builder may have
            // just finished). Report cleanly so the UI can clear its busy state.
            Err(format!("no in-flight agent for {bead_id}"))
        }
    }
}

/// Code-jx3.3 (RV6.3) — defer a bead on demand (`bd defer <id>`). A pure bd write:
/// it drops the bead out of `bd ready` so the conductor skips it on the next tick,
/// with no cancel handle needed. Leaves bd fully re-derivable. Emits a `deferred`
/// status so the feed reflects the operator's action.
#[tauri::command]
pub async fn conductor_defer_bead(
    app: AppHandle,
    repo_path: String,
    bead_id: String,
) -> Result<(), String> {
    bd_verb(&repo_path, &defer_args(&bead_id)).await?;
    let _ = bd_verb(&repo_path, &note_args(&bead_id, "conductor: deferred by operator")).await;
    emit_status(
        &app,
        ConductorStatus {
            state: "deferred",
            bead_id: Some(bead_id),
            detail: Some("deferred by operator".into()),
            last_pulse_ms: Some(now_ms()),
            interval_secs: DEFAULT_INTERVAL_SECS,
            repo_path,
            agent_status: None,
        },
    );
    Ok(())
}

/// DU3 (Code-d7j) — set the operator's default tier ceiling from the
/// Everyday/Heavy toggle. `tier` is one of "everyday" | "heavy" (the UI's two
/// modes) or the raw tier names "small" | "medium" | "large". Everyday maps to
/// Medium (Sonnet), Heavy to Large (Opus). A running conductor loop picks up the
/// new floor on its NEXT tick — no restart. Per-bead `size:`/`model:` labels
/// still override this default outright.
#[tauri::command]
pub fn conductor_set_default_tier(tier: String) -> Result<String, String> {
    let t = match tier.trim().to_ascii_lowercase().as_str() {
        "everyday" | "medium" | "med" | "m" => Tier::Medium,
        "heavy" | "large" | "l" | "xl" => Tier::Large,
        "small" | "s" => Tier::Small,
        other => return Err(format!("unknown tier: {other}")),
    };
    DEFAULT_TIER.store(t.as_u8(), std::sync::atomic::Ordering::Relaxed);
    Ok(t.tag().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // The two tests below both mutate the process-global DEFAULT_TIER atomic.
    // Rust runs tests concurrently, so guard them with a shared mutex to stop
    // one test's default from leaking into the other's resolve_tier reads.
    static TIER_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn resolve_interval_defaults_and_floors() {        assert_eq!(resolve_interval(None), DEFAULT_INTERVAL_SECS);
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
        let p = build_prompt("PRIMER", "Code-xyz", "Do a thing", "the description", "M", "one review pass");
        assert!(p.contains("Code-xyz"));
        assert!(p.contains("PRIMER"));
        assert!(p.contains("[M]"));
        assert!(p.contains("one review pass"));
        assert!(p.contains("ONE step") || p.contains("ONE unit of work"));
        assert!(p.contains("next pulse resumes") || p.contains("next pulse re-derives"));
        assert!(p.contains("Do NOT fake progress"));
    }

    #[test]
    fn builder_prompt_locks_merge_slot_contract() {
        // RV4.2 — a builder MUST be told to serialize through bd merge-slot and
        // stay on its own bead. Pin those clauses so a prompt edit can't quietly
        // drop the "no monkey knife fights" discipline.
        let p = build_builder_prompt("PRIMER", "Code-epic", "Code-child", "Child title", "S", "light review, auto-proceed");
        assert!(p.contains("Code-epic"));
        assert!(p.contains("Code-child"));
        assert!(p.contains("[S]"));
        assert!(p.contains("bd merge-slot acquire"));
        assert!(p.contains("bd merge-slot release"));
        assert!(p.contains("do NOT bypass it") || p.contains("do NOT bypass"));
        assert!(p.contains("Do NOT touch sibling beads"));
        assert!(p.contains("Do NOT fake progress"));
        assert!(p.contains("ONE step"));
    }

    #[test]
    fn resolve_tier_maps_size_labels() {
        let _g = TIER_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        // Explicit size labels are absolute — independent of the operator
        // default tier. (The default-tier fallback is exercised separately in
        // default_tier_toggle_moves_the_unlabeled_floor.)
        conductor_set_default_tier("small".into()).unwrap();
        // Default (no size hint) -> the Small operator default we just set.
        let (t, o) = resolve_tier(&["Beads-Station".into(), "perf".into()]);
        assert_eq!(t, Tier::Small);
        assert!(o.is_none());
        // size:S/M/L and short/long forms.
        assert_eq!(resolve_tier(&["size:s".into()]).0, Tier::Small);
        assert_eq!(resolve_tier(&["size:M".into()]).0, Tier::Medium);
        assert_eq!(resolve_tier(&["size:large".into()]).0, Tier::Large);
        assert_eq!(resolve_tier(&["sz:l".into()]).0, Tier::Large);
        assert_eq!(resolve_tier(&["size-m".into()]).0, Tier::Medium);
        // Case-insensitive.
        assert_eq!(resolve_tier(&["SIZE:L".into()]).0, Tier::Large);
    }

    #[test]
    fn default_tier_toggle_moves_the_unlabeled_floor() {
        let _g = TIER_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        // DU3: Everyday=Medium, Heavy=Large. An UNLABELED bead follows the
        // default; an explicitly-sized bead ignores it.
        conductor_set_default_tier("everyday".into()).unwrap();
        assert_eq!(resolve_tier(&["perf".into()]).0, Tier::Medium);
        assert_eq!(resolve_tier(&["size:s".into()]).0, Tier::Small); // explicit wins

        conductor_set_default_tier("heavy".into()).unwrap();
        assert_eq!(resolve_tier(&["perf".into()]).0, Tier::Large);
        assert_eq!(resolve_tier(&["size:m".into()]).0, Tier::Medium); // explicit wins

        // A model: override still wins outright regardless of the default.
        let (_, o) = resolve_tier(&["model:claude-opus-5".into()]);
        assert_eq!(o.as_deref(), Some("claude-opus-5"));

        // Reset so process-shared tests that assume Small aren't perturbed by
        // ordering.
        conductor_set_default_tier("small".into()).unwrap();

        // Bad input rejected.
        assert!(conductor_set_default_tier("bogus".into()).is_err());
    }

    #[test]
    fn resolve_tier_model_override_wins() {
        // A model: label overrides outright; the returned override string is
        // used raw by the caller regardless of any size label.
        let (t, o) = resolve_tier(&["size:s".into(), "model:claude-opus-5".into()]);
        assert_eq!(t, Tier::Small); // tier still parsed from size
        assert_eq!(o.as_deref(), Some("claude-opus-5")); // but override present
    }

    #[test]
    fn tier_models_are_distinct_and_ordered_by_cost() {
        assert_eq!(Tier::Small.model(), MODEL_SMALL);
        assert_eq!(Tier::Medium.model(), MODEL_MEDIUM);
        assert_eq!(Tier::Large.model(), MODEL_LARGE);
        assert_ne!(Tier::Small.model(), Tier::Medium.model());
        assert_ne!(Tier::Medium.model(), Tier::Large.model());
        // [L] ceremony must carry the mandatory-gate contract.
        assert!(Tier::Large.ceremony().to_lowercase().contains("gate"));
        assert!(Tier::Large.ceremony().to_lowercase().contains("adversarial"));
    }

    #[test]
    fn fanout_cap_is_bounded() {
        // The batch is `ready.take(MAX_FANOUT)` — assert the cap is a small,
        // positive bound so a wide epic never spawns an unbounded claude burst.
        assert!(MAX_FANOUT >= 1 && MAX_FANOUT <= 8, "MAX_FANOUT {MAX_FANOUT} out of sane range");
    }

    // Code-jx3.2 — the CONDUCTOR global is process-shared; serialize the two tests
    // that mutate it so one's inserted state can't leak into the other's read.
    static POSTURE_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn set_conductor(repo: &str, dry_run: bool, interval: u64) {
        let mut guard = CONDUCTOR.lock().unwrap();
        *guard = Some(ConductorState {
            repo_path: repo.to_string(),
            interval_secs: interval,
            dry_run,
            herdr_mode: false,
            stop: Arc::new(tokio::sync::Notify::new()),
        });
    }

    fn clear_conductor() {
        *CONDUCTOR.lock().unwrap() = None;
    }

    #[test]
    fn running_posture_none_when_no_loop() {
        let _g = POSTURE_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        clear_conductor();
        assert_eq!(running_posture("/repo/a"), None);
    }

    #[test]
    fn running_posture_inherits_matching_repo_only() {
        let _g = POSTURE_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        // A dry-run loop on /repo/a: a pulse-now for /repo/a inherits (true, 900);
        // a pulse-now for a DIFFERENT repo gets None (honors its own passed flag).
        set_conductor("/repo/a", true, 900);
        assert_eq!(running_posture("/repo/a"), Some((true, 900, false)));
        assert_eq!(running_posture("/repo/other"), None);

        // A live loop's posture is inherited verbatim — this is the safety point:
        // the UI can't downgrade a live loop, and can't upgrade a dry-run one.
        set_conductor("/repo/a", false, 1200);
        assert_eq!(running_posture("/repo/a"), Some((false, 1200, false)));

        clear_conductor();
    }

    // Code-jx3.3 — the in-flight registry bookkeeping (register/take/deregister).
    // The abort itself needs a live runtime + child process, so we test only the
    // bookkeeping: a registered bead is takeable exactly once, and deregister is a
    // clean no-op-after. Serialized so parallel tests can't cross-pollute the map.
    static IN_FLIGHT_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn in_flight_register_take_is_once() {
        let _g = IN_FLIGHT_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        IN_FLIGHT.lock().unwrap().clear();

        let _n = register_in_flight("Code-b1");
        // First take finds it; second take (after removal) is None.
        assert!(take_in_flight("Code-b1").is_some());
        assert!(take_in_flight("Code-b1").is_none());
        // Nothing registered for an unknown bead.
        assert!(take_in_flight("Code-nope").is_none());
    }

    #[test]
    fn in_flight_deregister_clears_the_entry() {
        let _g = IN_FLIGHT_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        IN_FLIGHT.lock().unwrap().clear();

        let _n = register_in_flight("Code-b2");
        deregister_in_flight("Code-b2");
        // After deregister, a stop finds nothing in flight.
        assert!(take_in_flight("Code-b2").is_none());
        // Re-registering the same bead overwrites cleanly (newest builder owns it).
        let _a = register_in_flight("Code-b3");
        let _b = register_in_flight("Code-b3");
        assert_eq!(IN_FLIGHT.lock().unwrap().get("Code-b3").is_some(), true);
        assert_eq!(IN_FLIGHT.lock().unwrap().len() >= 1, true);
        IN_FLIGHT.lock().unwrap().clear();
    }

    // RV7.3: PulseOutcome maps to the ConductorStatus.agent_status wire field.
    // Blocked carries "blocked" (drives the ActiveAgents blocked card); Completed
    // carries None (the FE renders the ordinary awake card, herdr or not).
    #[test]
    fn pulse_outcome_agent_status_wire() {
        assert_eq!(PulseOutcome::Blocked.agent_status(), Some("blocked".to_string()));
        assert_eq!(PulseOutcome::Completed.agent_status(), None);
    }
}
