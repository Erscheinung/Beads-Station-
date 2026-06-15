// bd subprocess bridge — Phase 1 (read-only).
// Spawns the local `bd` CLI as a child process with `--json` and parses
// its stdout into typed Rust structs. Mutations land in Phase 3.

use serde::{Deserialize, Serialize};
use tokio::process::Command;

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
async fn run_bd(repo_path: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    // Phase 2.5: launchd-launched GUIs inherit an empty PATH, so
    // `Command::new("bd")` resolves to nothing. Always go through
    // binresolve::resolve_bin to find the canonical absolute path.
    let bd_path = crate::binresolve::resolve_bin("bd")?;
    let mut cmd = Command::new(&bd_path);
    cmd.arg("-C").arg(repo_path);
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

/// `bd ready --json` — issues that have no open blockers.
#[tauri::command]
pub async fn bd_ready(repo_path: String) -> Result<Vec<Issue>, String> {
    let stdout = run_bd(
        &repo_path,
        &["ready", "--json", "--actor", "Beads Station"],
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
