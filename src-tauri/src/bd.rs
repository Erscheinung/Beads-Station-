// bd subprocess bridge — Phase 1 (read-only) + Phase 3 (mutations).
// Spawns the local `bd` CLI as a child process with `--json` for reads
// and bare flags for writes, parsing stdout into typed Rust structs.
//
// IMPORTANT (BEADS-CONTEXT.md gotcha): bd reads `git config beads.role`
// from the *process cwd*, not from `-C <path>`. If we use `-C` from a
// different cwd, bd prints a role-not-configured warning and may
// silently drop writes. We therefore set `current_dir(repo_path)` on
// every spawn and never pass `-C`.

use serde::{Deserialize, Serialize};
use tokio::process::Command;

pub(crate) const ACTOR: &str = "Beads Station";

/// Outcome of a `bd` subprocess run. `NoDatabase` is the classified
/// "no beads database found" case (project has no `.beads/` dir). Reads
/// map it to an empty result; writes surface it as a real error so a
/// mutation never silently succeeds against a missing db.
enum BdOutcome {
    Ok(Vec<u8>),
    NoDatabase,
}

/// Pure classifier: does this bd stderr indicate a missing database?
/// Pinned to bd 1.0.4 wording. A wording change breaks the test, which is
/// the point — we want to catch it.
fn is_no_database(stderr: &str) -> bool {
    stderr.contains("no beads database found")
}

/// Mirrors the bd issue JSON shape. Every field is `#[serde(default)]`
/// because bd's JSON omits optional fields rather than emitting nulls,
/// and the schema has drifted across releases.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct Issue {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub acceptance_criteria: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub issue_type: String,
    #[serde(default)]
    pub assignee: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub closed_at: Option<String>,
    #[serde(default)]
    pub dependency_count: i32,
    #[serde(default)]
    pub dependent_count: i32,
    #[serde(default)]
    pub comment_count: i32,
    #[serde(default)]
    pub labels: Option<Vec<String>>,
    /// RV5.1 — true for ephemeral wisps (bd `--ephemeral`). bd omits this on
    /// permanent beads (serde default = false). Wisps live only in the Sensors
    /// panel; the board/ready/counts views filter them out (see `drop_wisps`).
    #[serde(default)]
    pub ephemeral: bool,
    #[serde(default)]
    pub parent: Option<String>,
    // bd's `--json` emits the full dependency edge list here. We keep only the
    // fields the graph needs; extra fields (created_at/by, metadata) are dropped
    // by serde since they're absent from the struct.
    #[serde(default)]
    pub dependencies: Vec<Dependency>,
}

/// A single bd dependency edge. `depends_on_id` blocks `issue_id`; `type` is
/// bd's link kind ("blocks", "parent-child", etc.).
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct Dependency {
    #[serde(default)]
    pub issue_id: String,
    #[serde(default, alias = "id")]
    pub depends_on_id: String,
    #[serde(default, rename = "type", alias = "dependency_type")]
    pub dep_type: String,
}

/// Run `bd` and classify the outcome. Returns `BdOutcome::Ok(stdout)` on
/// success and `BdOutcome::NoDatabase` when bd exited nonzero solely because
/// the project has no `.beads/` dir. Any other nonzero exit is a real
/// `Err`. This lets read commands degrade to empty on a dbless repo while
/// writes still surface the error.
///
/// Uses `current_dir(repo_path)` instead of bd's `-C` flag because bd
/// reads `git config beads.role` from the process cwd. Setting cwd
/// ensures the role check lands against the correct repo and writes
/// actually persist.
async fn run_bd_classified(repo_path: &str, args: &[&str]) -> Result<BdOutcome, String> {
    // The spawn governor now owns BOTH the concurrency cap (one process-global
    // permit pool shared with git/claude) AND the resource-exhaustion retry
    // policy (EMFILE + EAGAIN). `run_bd_once` acquires + holds a permit for its
    // whole spawn; `with_retry` re-runs it on a transient exhaustion. bd reads
    // are short-lived (fully awaited within the call) so acquiring the permit
    // inside the retried op is correct — it releases when the op returns.
    crate::spawngov::with_retry(|| run_bd_once(repo_path, args)).await
}

/// A single bd spawn + classify (no retry). Acquires a governor permit for the
/// duration of the spawn so bd children count against the same global cap as
/// git/claude. Split out so `run_bd_classified` can wrap it in the retry loop.
async fn run_bd_once(repo_path: &str, args: &[&str]) -> Result<BdOutcome, String> {
    // Hold a permit for the whole spawn+await. bd fully completes within this
    // call, so the permit drops at end of scope (unlike claude, which must hold
    // its permit far longer — see claude.rs).
    let _permit = crate::spawngov::permit().await;

    // Phase 2.5: launchd-launched GUIs inherit an empty PATH, so
    // `Command::new("bd")` resolves to nothing. Always go through
    // binresolve::resolve_bin to find the canonical absolute path.
    let bd_path = crate::binresolve::resolve_bin("bd")?;
    let mut cmd = Command::new(&bd_path);
    cmd.current_dir(repo_path);
    for a in args {
        cmd.arg(a);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("failed to spawn bd: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Classify the missing-db case so reads can degrade to empty while
        // writes still error. Pinned to bd 1.0.4 wording; see the unit test.
        if is_no_database(&stderr) {
            return Ok(BdOutcome::NoDatabase);
        }
        return Err(format!("bd exited with {}: {}", output.status, stderr.trim()));
    }
    Ok(BdOutcome::Ok(output.stdout))
}

/// Run `bd` with the given args under `repo_path` and return stdout bytes.
/// Delegates to `run_bd_classified`, collapsing `NoDatabase` back into an
/// `Err` so writes (via `run_bd_write`) still error honestly on a repo
/// with no `.beads/` dir.
async fn run_bd(repo_path: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    match run_bd_classified(repo_path, args).await? {
        BdOutcome::Ok(bytes) => Ok(bytes),
        BdOutcome::NoDatabase => Err("no beads database found".to_string()),
    }
}

/// Run a bd write subcommand and discard stdout. Returns trimmed
/// stderr on non-zero exit (or spawn failure).
async fn run_bd_write(repo_path: &str, args: &[&str]) -> Result<(), String> {
    run_bd(repo_path, args).await.map(|_| ())
}

/// RV4.1 — crate-internal escape hatch for the conductor to run bd verbs that
/// have no `#[tauri::command]` wrapper (doctor / defer / remember / mol) while
/// still sharing `BD_SEMAPHORE` + the EAGAIN-retry loop. The conductor must NOT
/// spawn `bd` itself — that would bypass the RV3.1 fork-storm guard. Returns
/// stdout bytes; `NoDatabase` collapses to an `Err` like `run_bd`.
pub(crate) async fn run_bd_verb(repo_path: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    run_bd(repo_path, args).await
}

fn require_nonempty(field: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{field} must not be empty"))
    } else {
        Ok(())
    }
}

/// Validates a status string against bd's canonical set. The four
/// values the board exposes are open / in_progress / blocked / closed.
/// bd also accepts deferred / pinned / hooked but those aren't board
/// transitions, so we reject them at the boundary.
fn validate_status(status: &str) -> Result<(), String> {
    match status {
        "open" | "in_progress" | "blocked" | "closed" => Ok(()),
        other => Err(format!(
            "invalid status \"{other}\" (expected open, in_progress, blocked, or closed)"
        )),
    }
}

// ---------- reads ----------

/// RV5.1 — strip ephemeral wisps from a board/ready result. Wisps carry
/// `ephemeral: true` and leak into `bd ready`/`bd list`; they belong only in the
/// Sensors panel (see sense.rs), never in the board columns or the counts. Pure
/// so it's unit-testable without a live bd.
pub(crate) fn drop_wisps(issues: Vec<Issue>) -> Vec<Issue> {
    issues.into_iter().filter(|i| !i.ephemeral).collect()
}

/// `bd ready --json` — issues that have no open blockers.
#[tauri::command]
pub async fn bd_ready(repo_path: String) -> Result<Vec<Issue>, String> {
    match run_bd_classified(&repo_path, &["ready", "--json", "--actor", ACTOR]).await? {
        BdOutcome::NoDatabase => Ok(vec![]),
        BdOutcome::Ok(stdout) => serde_json::from_slice::<Vec<Issue>>(&stdout)
            .map(drop_wisps)
            .map_err(|e| format!("failed to parse bd ready JSON: {e}")),
    }
}

/// `bd show <id> --json --long` — full issue detail.
#[tauri::command]
pub async fn bd_show(repo_path: String, id: String) -> Result<Issue, String> {
    let stdout = run_bd(&repo_path, &["show", &id, "--json", "--long"]).await?;
    parse_show(&stdout, &id)
}

/// Current bd returns an array even for one ID; older versions returned an object.
fn parse_show(stdout: &[u8], requested_id: &str) -> Result<Issue, String> {
    let value: serde_json::Value = serde_json::from_slice(stdout)
        .map_err(|e| format!("failed to parse bd show JSON: {e}"))?;
    let issues: Vec<Issue> = if value.is_array() {
        serde_json::from_value(value)
    } else {
        serde_json::from_value(value).map(|issue| vec![issue])
    }.map_err(|e| format!("failed to parse bd show JSON: {e}"))?;
    let mut issue = issues.into_iter().find(|issue| issue.id == requested_id)
        .ok_or_else(|| format!("bd show returned no matching issue for {requested_id}"))?;
    for dependency in &mut issue.dependencies {
        if dependency.issue_id.is_empty() {
            dependency.issue_id = issue.id.clone();
        }
    }
    Ok(issue)
}

/// `bd list --json [--status <filter>]`. `status_filter = None` lists all.
#[tauri::command]
pub async fn bd_list(
    repo_path: String,
    status_filter: Option<String>,
) -> Result<Vec<Issue>, String> {
    let mut args: Vec<&str> = vec!["list", "--json"];
    if let Some(ref s) = status_filter {
        args.push("--status");
        args.push(s.as_str());
    }
    match run_bd_classified(&repo_path, &args).await? {
        BdOutcome::NoDatabase => Ok(vec![]),
        BdOutcome::Ok(stdout) => serde_json::from_slice::<Vec<Issue>>(&stdout)
            .map(drop_wisps)
            .map_err(|e| format!("failed to parse bd list JSON: {e}")),
    }
}

// ---------- writes (Phase 3) ----------

/// `bd create <title> -t task -p <priority> --json --actor "Beads Station"` —
/// creates a new task and returns its parsed id. Phase 9 (Code-ky4.9): the
/// command palette's "New issue" command. `priority` defaults to "2" (medium)
/// when None; bd accepts "0"-"4" or "P0"-"P4". Returns the new issue id so the
/// FE can surface it / refresh.
#[tauri::command]
pub async fn bd_create(
    repo_path: String,
    title: String,
    priority: Option<String>,
) -> Result<String, String> {
    require_nonempty("title", &title)?;
    let prio = priority.unwrap_or_else(|| "2".to_string());
    let stdout = run_bd(
        &repo_path,
        &[
            "create", &title, "-t", "task", "-p", &prio, "--json", "--actor", ACTOR,
        ],
    )
    .await?;
    // `bd create --json` emits a single issue object; pull its id.
    let v: serde_json::Value = serde_json::from_slice(&stdout)
        .map_err(|e| format!("failed to parse bd create JSON: {e}"))?;
    v.get("id")
        .and_then(|id| id.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "bd create JSON missing 'id'".to_string())
}

/// `bd update <id> --claim --actor "Beads Station"` — atomically sets
/// assignee=Beads Station and status=in_progress. Idempotent if the
/// issue is already claimed by us.
#[tauri::command]
pub async fn bd_claim(repo_path: String, id: String) -> Result<(), String> {
    require_nonempty("id", &id)?;
    run_bd_write(
        &repo_path,
        &["update", &id, "--claim", "--actor", ACTOR],
    )
    .await
}

/// `bd update <id> --status <status> --actor "Beads Station"` —
/// transitions the issue to `status`. Use `bd_close` for the closed
/// transition when a reason is needed.
#[tauri::command]
pub async fn bd_set_status(
    repo_path: String,
    id: String,
    status: String,
) -> Result<(), String> {
    require_nonempty("id", &id)?;
    require_nonempty("status", &status)?;
    validate_status(&status)?;
    run_bd_write(
        &repo_path,
        &[
            "update", &id, "--status", &status, "--actor", ACTOR,
        ],
    )
    .await
}

/// `bd close <id> --reason "<text>" --actor "Beads Station"` —
/// closes (status=closed) with an audit-trail reason.
#[tauri::command]
pub async fn bd_close(
    repo_path: String,
    id: String,
    reason: Option<String>,
) -> Result<(), String> {
    require_nonempty("id", &id)?;
    let reason = reason.unwrap_or_else(|| "Closed via Beads Station".to_string());
    require_nonempty("reason", &reason)?;
    run_bd_write(
        &repo_path,
        &["close", &id, "--reason", &reason, "--actor", ACTOR],
    )
    .await
}

/// `bd update <id> --add-label <label> --actor "Beads Station"` —
/// adds a single label. Repeat the call for multiple labels.
#[tauri::command]
pub async fn bd_add_label(
    repo_path: String,
    id: String,
    label: String,
) -> Result<(), String> {
    require_nonempty("id", &id)?;
    require_nonempty("label", &label)?;
    run_bd_write(
        &repo_path,
        &[
            "update", &id, "--add-label", &label, "--actor", ACTOR,
        ],
    )
    .await
}

/// `bd update <id> --remove-label <label> --actor "Beads Station"`.
#[tauri::command]
pub async fn bd_remove_label(
    repo_path: String,
    id: String,
    label: String,
) -> Result<(), String> {
    require_nonempty("id", &id)?;
    require_nonempty("label", &label)?;
    run_bd_write(
        &repo_path,
        &[
            "update", &id, "--remove-label", &label, "--actor", ACTOR,
        ],
    )
    .await
}

/// `bd note <id> "<text>" --actor "Beads Station"` — appends a note.
#[tauri::command]
pub async fn bd_note(
    repo_path: String,
    id: String,
    text: String,
) -> Result<(), String> {
    require_nonempty("id", &id)?;
    require_nonempty("text", &text)?;
    run_bd_write(
        &repo_path,
        &["note", &id, &text, "--actor", ACTOR],
    )
    .await
}

// ---------- RV5.0: cockpit gate view ----------

/// A bd gate issue (issue_type == "gate"). Gates are async wait conditions that
/// block a workflow step; a `human` gate is closed manually to let the step
/// proceed. Mirrors `bd gate list --json` — bd emits snake_case, so this struct
/// stays snake_case (no camelCase rename) and the TS bridge reads the same
/// field names. Only the fields the cockpit renders are kept.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct Gate {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: String,
    /// bd's gate kind: "human" | "timer" | "gh:run" | "gh:pr" | "bead".
    #[serde(default)]
    pub await_type: String,
    /// True for the uninstantiated formula-proto gate (a template artifact, not
    /// a live gate). The cockpit filters these out.
    #[serde(default)]
    pub is_template: bool,
    #[serde(default)]
    pub created_at: String,
}

/// Pure filter: the gates a human can act on in the cockpit — open, human-type,
/// and not a formula-proto template artifact. Split out so it's unit-testable
/// without a live bd.
fn actionable_human_gates(all: Vec<Gate>) -> Vec<Gate> {
    all.into_iter()
        .filter(|g| !g.is_template && g.status == "open" && g.await_type == "human")
        .collect()
}

/// `bd gate list --json` — open HUMAN gates only, template artifacts filtered
/// out. These are the gates a human resolves in the cockpit; timer/gh/bead
/// gates resolve themselves and aren't actionable here. NoDatabase -> empty.
#[tauri::command]
pub async fn bd_gate_list(repo_path: String) -> Result<Vec<Gate>, String> {
    match run_bd_classified(&repo_path, &["gate", "list", "--json"]).await? {
        BdOutcome::NoDatabase => Ok(vec![]),
        BdOutcome::Ok(stdout) => {
            let all: Vec<Gate> = serde_json::from_slice(&stdout)
                .map_err(|e| format!("failed to parse bd gate list JSON: {e}"))?;
            Ok(actionable_human_gates(all))
        }
    }
}

/// `bd gate resolve <id>` — the APPROVE action: manually close a human gate so
/// its blocked step proceeds. (Distinct from `bd close`: gates have their own
/// resolve verb that also re-evaluates the blocked step.)
#[tauri::command]
pub async fn bd_gate_resolve(repo_path: String, id: String) -> Result<(), String> {
    require_nonempty("id", &id)?;
    run_bd_write(&repo_path, &["gate", "resolve", &id]).await
}

// ---------- Phase 4: statusline helpers ----------

/// `git -C <repo_path> rev-parse --abbrev-ref HEAD` — returns
/// the current branch name, or "(detached)" / "(no-git)" / "(unknown)"
/// when the repo is detached / not a git repo / fails to spawn.
#[tauri::command]
pub async fn bd_git_branch(repo_path: String) -> Result<String, String> {
    // Governed like every other spawn: git is cheap but Statusline used to fire
    // it on every bd_changed unthrottled, adding forks during a storm. One
    // permit for the whole (short) spawn; retry on transient exhaustion.
    crate::spawngov::with_retry(|| async {
        let _permit = crate::spawngov::permit().await;
        let git_path = crate::binresolve::resolve_bin("git")?;
        let output = tokio::process::Command::new(&git_path)
            .arg("-C").arg(&repo_path)
            .arg("rev-parse").arg("--abbrev-ref").arg("HEAD")
            .output()
            .await
            .map_err(|e| format!("git spawn failed: {e}"))?;
        if !output.status.success() {
            return Ok("(no-git)".into());
        }
        let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(if s == "HEAD" { "(detached)".into() } else { s })
    })
    .await
}

/// Returns ready/in_progress/blocked/closed counts for the repo so the
/// statusline can render `ready=N blocked=M closed=K` in one round-trip.
#[derive(serde::Serialize)]
pub struct BdCounts {
    pub ready: usize,
    pub in_progress: usize,
    pub blocked: usize,
    pub closed: usize,
}

#[tauri::command]
pub async fn bd_counts(repo_path: String) -> Result<BdCounts, String> {
    let start = std::time::Instant::now();
    let (ready, all) = tokio::try_join!(
        bd_ready(repo_path.clone()),
        bd_list(repo_path.clone(), None),
    )?;
    let mut c = BdCounts {
        ready: ready.len(),
        in_progress: 0,
        blocked: 0,
        closed: 0,
    };
    for i in &all {
        match i.status.as_str() {
            "in_progress" => c.in_progress += 1,
            "blocked" => c.blocked += 1,
            "closed" => c.closed += 1,
            _ => {}
        }
    }
    tracing::info!(repo = %repo_path, elapsed_ms = start.elapsed().as_millis() as u64, ready = c.ready, in_progress = c.in_progress, blocked = c.blocked, closed = c.closed, "bd_counts");
    Ok(c)
}

/// RV3.3 — one shared read for all three FE consumers (Board, IssueList,
/// Statusline). Returns the full `ready` and `all` issue vectors in a single
/// round-trip so the frontend can derive the board columns, the sidebar tree,
/// AND the statusline counts from ONE fetch instead of each component spawning
/// its own `bd` subprocess per change. Same `try_join(bd_ready, bd_list)` shape
/// as `bd_counts`; the FE `bdCache` dedups concurrent callers so a `bd_changed`
/// burst collapses to a single `bd_snapshot`. `bd_counts` is retained for
/// back-compat (unused after the rewire).
#[derive(serde::Serialize)]
pub struct BdSnapshot {
    pub ready: Vec<Issue>,
    pub all: Vec<Issue>,
    /// RV3.7 (Code-hc9) — true ONLY when a read classified as NoDatabase
    /// (`bd` exited nonzero with "no beads database found"). Distinguishes a
    /// repo that genuinely has no `.beads/` db from a repo that really is empty
    /// (both otherwise arrive as {ready:[], all:[]}). The FE gates its "no beads
    /// db" label on this instead of on `all.length === 0`, so an empty-but-real
    /// repo no longer mislabels as no-db. A degraded read under fork pressure
    /// surfaces as an Err (resource-exhaustion retry then error), NOT here.
    pub no_db: bool,
}

/// Parse a classified read into issues, treating NoDatabase as an empty vec but
/// signalling it via the returned bool so the caller can preserve the
/// distinction (see BdSnapshot::no_db).
fn parse_read(outcome: BdOutcome, what: &str) -> Result<(Vec<Issue>, bool), String> {
    match outcome {
        BdOutcome::NoDatabase => Ok((vec![], true)),
        BdOutcome::Ok(stdout) => serde_json::from_slice::<Vec<Issue>>(&stdout)
            .map(|v| (drop_wisps(v), false))
            .map_err(|e| format!("failed to parse bd {what} JSON: {e}")),
    }
}

#[tauri::command]
pub async fn bd_snapshot(repo_path: String) -> Result<BdSnapshot, String> {
    let start = std::time::Instant::now();
    // Use the classified runner directly (not bd_ready/bd_list, which collapse
    // NoDatabase to Ok(vec![])) so we can tell a missing db from an empty repo.
    let (ready_out, all_out) = tokio::try_join!(
        run_bd_classified(&repo_path, &["ready", "--json", "--actor", ACTOR]),
        run_bd_classified(&repo_path, &["list", "--json"]),
    )?;
    let (ready, ready_nodb) = parse_read(ready_out, "ready")?;
    let (all, all_nodb) = parse_read(all_out, "list")?;
    let no_db = ready_nodb && all_nodb;
    tracing::info!(
        repo = %repo_path,
        elapsed_ms = start.elapsed().as_millis() as u64,
        ready = ready.len(),
        all = all.len(),
        no_db,
        "bd_snapshot"
    );
    Ok(BdSnapshot { ready, all, no_db })
}

// ---------- Phase 6: bd prime injector ----------

/// `bd prime` — runs the bd workflow primer subcommand under
/// `current_dir(repo_path)` and returns its stdout. The FE injects this
/// text as a `<system-reminder>...</system-reminder>` block at the top of
/// every Claude session so the agent loads the project's beads workflow
/// rules before its first user turn.
///
/// 5-second hard timeout: bd prime should be a near-instant local read;
/// if it stalls (Dolt lock contention, missing binary, etc.) we'd rather
/// surface a non-fatal error to the FE than block ClaudeChat mount.
#[tauri::command]
pub async fn bd_prime(repo_path: String) -> Result<String, String> {
    // Acquire a governor permit BEFORE arming the 5s timeout. Previously this
    // spawned directly (bypassing the cap) and started the timeout immediately,
    // so a prime that merely QUEUED behind other spawns during a burst counted
    // its wait against the 5s budget and false-"timed out" — the exact
    // "bd prime timed out after 5s" the storm produced. The timeout now measures
    // only bd's actual runtime, and the spawn counts against the global cap.
    let _permit = crate::spawngov::permit().await;

    let bd_path = crate::binresolve::resolve_bin("bd")?;
    let mut cmd = tokio::process::Command::new(&bd_path);
    cmd.current_dir(&repo_path);
    cmd.arg("prime");

    let fut = cmd.output();
    let output = tokio::time::timeout(std::time::Duration::from_secs(5), fut)
        .await
        .map_err(|_| "bd prime timed out after 5s".to_string())?
        .map_err(|e| format!("failed to spawn bd prime: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "bd prime exited with {}: {}",
            output.status,
            stderr.trim()
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// A single node in a swarm status listing (a child of the epic). bd's
/// `swarm status --json` emits richer per-state objects, but the conductor
/// only needs id + title to fan out a builder pulse per ready child.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct SwarmNode {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
}

/// Parsed `bd swarm status <epic> --json`. Only the fields the RV4.2 fanout
/// reads are kept; serde drops the rest (active/blocked/completed detail,
/// progress_percent, schema_version). `ready` = open children with all deps
/// satisfied — the set the pulse can safely run in parallel.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct SwarmStatus {
    #[serde(default)]
    pub epic_id: String,
    #[serde(default)]
    pub ready: Vec<SwarmNode>,
    #[serde(default)]
    pub ready_count: i32,
    #[serde(default)]
    pub active_count: i32,
    #[serde(default)]
    pub blocked_count: i32,
}

/// RV4.2 — `bd swarm status <epic> --json`, parsed. Crate-internal (the
/// conductor's fanout reads it; no FE surface yet). Shares the semaphore +
/// EAGAIN retry via run_bd_classified. NoDatabase collapses to an empty status.
pub(crate) async fn swarm_status(repo_path: &str, epic_id: &str) -> Result<SwarmStatus, String> {
    match run_bd_classified(repo_path, &["swarm", "status", epic_id, "--json"]).await? {
        BdOutcome::NoDatabase => Ok(SwarmStatus::default()),
        BdOutcome::Ok(stdout) => serde_json::from_slice::<SwarmStatus>(&stdout)
            .map_err(|e| format!("failed to parse bd swarm status JSON: {e}")),
    }
}

/// RV4.2 — ensure a swarm molecule exists for `epic_id` before the fanout reads
/// its status. `bd swarm create` is idempotent enough for our use: if a swarm
/// molecule already links the epic, a second create is a cheap no-op/expected
/// error we swallow (the fanout only needs the DAG, which `swarm status`
/// computes from beads regardless of whether a molecule row exists). Best-effort.
pub(crate) async fn swarm_create(repo_path: &str, epic_id: &str) -> Result<(), String> {
    // create can legitimately "fail" if a swarm already exists — treat any
    // error as non-fatal since status is computed from beads, not the molecule.
    let _ = run_bd_verb(repo_path, &["swarm", "create", epic_id]).await;
    Ok(())
}

/// RV8.2 — parsed `bd merge-slot check --json`. The merge slot is a SINGLE global
/// bead per rig (`<prefix>-merge-slot`); `available` is true when open, `holder`
/// carries whatever `--holder` the acquirer passed (the conductor tags builders
/// `builder:<bead-id>` so a killed builder's leaked slot can be reclaimed). Only
/// the fields the release-guard reads are kept; `waiters` etc. are dropped.
#[derive(Deserialize, Debug, Clone, Default)]
pub(crate) struct MergeSlot {
    #[serde(default)]
    pub available: bool,
    #[serde(default)]
    pub holder: Option<String>,
    // Parsed for diagnostics and covered by wire-format tests; the release
    // guard currently needs only availability and holder.
    #[allow(dead_code)]
    #[serde(default)]
    pub id: String,
}

/// RV8.2 — read the merge slot state. NoDatabase collapses to a default (available)
/// slot so a repo without bd never trips the release path. Shares the semaphore +
/// EAGAIN retry via run_bd_classified.
pub(crate) async fn merge_slot_check(repo_path: &str) -> Result<MergeSlot, String> {
    match run_bd_classified(repo_path, &["merge-slot", "check", "--json"]).await? {
        BdOutcome::NoDatabase => Ok(MergeSlot { available: true, ..Default::default() }),
        BdOutcome::Ok(stdout) => serde_json::from_slice::<MergeSlot>(&stdout)
            .map_err(|e| format!("failed to parse bd merge-slot check JSON: {e}")),
    }
}

/// RV8.2 — release the merge slot on behalf of `holder`. `--holder` is verified by
/// bd, so this is a no-op if a different holder owns the slot (the guard in
/// `release_merge_slot_if_held` also checks first). ACTOR rides the audit trail.
pub(crate) async fn merge_slot_release(repo_path: &str, holder: &str) -> Result<(), String> {
    let args = release_args(holder);
    let slices: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_bd_verb(repo_path, &slices).await.map(|_| ())
}

/// Pure arg builder for `bd merge-slot release --holder <holder> --actor <ACTOR>`.
/// Split out so the wire shape is unit-testable without a runtime.
fn release_args(holder: &str) -> Vec<String> {
    vec![
        "merge-slot".into(),
        "release".into(),
        "--holder".into(),
        holder.into(),
        "--actor".into(),
        ACTOR.into(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn show_accepts_current_array_and_legacy_object() {
        for json in [r#"[{"id":"Code-oan","title":"Fix startup"}]"#, r#"{"id":"Code-oan","title":"Fix startup"}"#] {
            assert_eq!(parse_show(json.as_bytes(), "Code-oan").unwrap().title, "Fix startup");
        }
        assert!(parse_show(b"[]", "Code-oan").is_err());
        assert!(parse_show(br#"[{"id":"different"}]"#, "Code-oan").is_err());
        assert!(parse_show(b"invalid", "Code-oan").is_err());
        let detail = parse_show(br#"[{"id":"a","dependencies":[{"id":"b","dependency_type":"blocks"}]}]"#, "a").unwrap();
        assert_eq!(detail.dependencies[0].issue_id, "a");
        assert_eq!(detail.dependencies[0].depends_on_id, "b");
        assert_eq!(detail.dependencies[0].dep_type, "blocks");
    }

    #[test]
    fn classifies_missing_db() {
        assert!(is_no_database("Error: no beads database found. Hint: run 'bd where'"));
    }

    #[test]
    fn other_errors_are_not_missing_db() {
        assert!(!is_no_database("Error: some other failure"));
        assert!(!is_no_database(""));
    }

    #[test]
    fn actionable_human_gates_filters_correctly() {
        // RV5.0 — the cockpit lists only open, human, non-template gates.
        let raw = br#"[
            {"id":"g1","title":"Gate: human","status":"open","await_type":"human","is_template":false},
            {"id":"g-tmpl","title":"Gate: human","status":"open","await_type":"human","is_template":true},
            {"id":"g-closed","title":"Gate: human","status":"closed","await_type":"human","is_template":false},
            {"id":"g-timer","title":"Gate: timer","status":"open","await_type":"timer","is_template":false}
        ]"#;
        let all: Vec<Gate> = serde_json::from_slice(raw).unwrap();
        let out = actionable_human_gates(all);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "g1");
        assert_eq!(out[0].await_type, "human");
    }

    #[test]
    fn merge_slot_check_parses_json() {
        // RV8.2 — the release guard reads available/holder/id off
        // `bd merge-slot check --json`. Pin the shape; waiters + extra keys drop.
        let raw = br#"{
            "available": false,
            "holder": "builder:Code-child",
            "id": "Code-merge-slot",
            "waiters": ["a", "b"]
        }"#;
        let slot: MergeSlot = serde_json::from_slice(raw).unwrap();
        assert!(!slot.available);
        assert_eq!(slot.holder.as_deref(), Some("builder:Code-child"));
        assert_eq!(slot.id, "Code-merge-slot");
        // An available slot with a null holder parses cleanly too.
        let open: MergeSlot =
            serde_json::from_slice(br#"{"available":true,"holder":null,"id":"Code-merge-slot"}"#).unwrap();
        assert!(open.available);
        assert!(open.holder.is_none());
    }

    #[test]
    fn release_args_shape() {
        assert_eq!(
            release_args("builder:Code-child"),
            vec![
                "merge-slot",
                "release",
                "--holder",
                "builder:Code-child",
                "--actor",
                "Beads Station",
            ]
        );
    }

    #[test]
    fn parse_swarm_status_json() {
        // RV4.2 — the fanout reads .ready off `bd swarm status --json`. Pin the
        // shape (epic_id + ready[].id/title + counts); extra keys are dropped.
        let raw = br#"{
            "epic_id": "Code-ky4",
            "epic_title": "Epic",
            "progress_percent": 70,
            "schema_version": 1,
            "total_issues": 10,
            "active": [], "active_count": 0,
            "blocked": [{"id":"Code-ky4.10","title":"P10","blocked_by":["Code-ky4.9"]}],
            "blocked_count": 1,
            "completed": [{"id":"Code-ky4.1","title":"P1","closed_at":"2026-06-12"}],
            "ready": [
                {"id":"Code-ky4.8","title":"Phase 8"},
                {"id":"Code-ky4.9","title":"Phase 9"}
            ],
            "ready_count": 2
        }"#;
        let s: SwarmStatus = serde_json::from_slice(raw).unwrap();
        assert_eq!(s.epic_id, "Code-ky4");
        assert_eq!(s.ready_count, 2);
        assert_eq!(s.blocked_count, 1);
        assert_eq!(s.ready.len(), 2);
        assert_eq!(s.ready[0].id, "Code-ky4.8");
        assert_eq!(s.ready[1].title, "Phase 9");
    }

    #[test]
    fn parse_read_flags_no_database() {
        // RV3.7 (Code-hc9) — a NoDatabase read must surface no_db=true so the
        // FE can distinguish a missing db from a genuinely-empty repo.
        let (issues, no_db) = parse_read(BdOutcome::NoDatabase, "list").unwrap();
        assert!(issues.is_empty());
        assert!(no_db);
    }

    #[test]
    fn parse_read_empty_json_is_not_no_database() {
        // An empty but real repo: bd returns "[]" with a live db -> no_db=false.
        let (issues, no_db) = parse_read(BdOutcome::Ok(b"[]".to_vec()), "list").unwrap();
        assert!(issues.is_empty());
        assert!(!no_db);
    }
}
