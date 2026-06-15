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

const ACTOR: &str = "Beads Station";

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
    #[serde(default)]
    pub parent: Option<String>,
}

/// Run `bd` with the given args under `repo_path` and return stdout bytes.
///
/// Uses `current_dir(repo_path)` instead of bd's `-C` flag because bd
/// reads `git config beads.role` from the process cwd. Setting cwd
/// ensures the role check lands against the correct repo and writes
/// actually persist.
async fn run_bd(repo_path: &str, args: &[&str]) -> Result<Vec<u8>, String> {
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
        return Err(format!(
            "bd exited with {}: {}",
            output.status,
            stderr.trim()
        ));
    }
    Ok(output.stdout)
}

/// Run a bd write subcommand and discard stdout. Returns trimmed
/// stderr on non-zero exit (or spawn failure).
async fn run_bd_write(repo_path: &str, args: &[&str]) -> Result<(), String> {
    run_bd(repo_path, args).await.map(|_| ())
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

/// `bd ready --json` — issues that have no open blockers.
#[tauri::command]
pub async fn bd_ready(repo_path: String) -> Result<Vec<Issue>, String> {
    let stdout = run_bd(
        &repo_path,
        &["ready", "--json", "--actor", ACTOR],
    )
    .await?;
    serde_json::from_slice::<Vec<Issue>>(&stdout)
        .map_err(|e| format!("failed to parse bd ready JSON: {e}"))
}

/// `bd show <id> --json --long` — full issue detail.
#[tauri::command]
pub async fn bd_show(repo_path: String, id: String) -> Result<Issue, String> {
    let stdout = run_bd(&repo_path, &["show", &id, "--json", "--long"]).await?;
    serde_json::from_slice::<Issue>(&stdout)
        .map_err(|e| format!("failed to parse bd show JSON: {e}"))
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
    let stdout = run_bd(&repo_path, &args).await?;
    serde_json::from_slice::<Vec<Issue>>(&stdout)
        .map_err(|e| format!("failed to parse bd list JSON: {e}"))
}

// ---------- writes (Phase 3) ----------

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
    reason: String,
) -> Result<(), String> {
    require_nonempty("id", &id)?;
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

// ---------- Phase 4: statusline helpers ----------

/// `git -C <repo_path> rev-parse --abbrev-ref HEAD` — returns
/// the current branch name, or "(detached)" / "(no-git)" / "(unknown)"
/// when the repo is detached / not a git repo / fails to spawn.
#[tauri::command]
pub async fn bd_git_branch(repo_path: String) -> Result<String, String> {
    // Use std::process not tokio — tiny one-shot, doesn't need async I/O
    // but we keep the signature async for tauri compat. Use tokio::process.
    let output = tokio::process::Command::new("git")
        .arg("-C").arg(&repo_path)
        .arg("rev-parse").arg("--abbrev-ref").arg("HEAD")
        .output()
        .await
        .map_err(|e| format!("git spawn failed: {e}"))?;
    if !output.status.success() {
        return Ok("(no-git)".into());
    }
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if s == "HEAD" { Ok("(detached)".into()) } else { Ok(s) }
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
    let ready = bd_ready(repo_path.clone()).await?;
    let all = bd_list(repo_path.clone(), None).await?;
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
    Ok(c)
}
