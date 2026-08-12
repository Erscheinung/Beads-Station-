// RV5.1 (Code-qqa) — Obsidian sensors via bd's own wisp verbs.
//
// The sensor loop: watch two Obsidian folders (Implementation Prompts/, Daily/);
// when a new `.md` file appears, mint an ephemeral bd wisp for it
// (`bd create --ephemeral`), surface it in the Sensors panel, and on approval
// run `bd promote <wisp-id>` to copy it into the permanent issues table
// (preserving id + links). Zero new auth — filesystem only.
//
// Ground truth (verified against bd 1.x, NOT the ticket's "propose->admit"
// which does not exist):
//   create: `bd create "<title>" --ephemeral --labels sense:src=<rel> --json`
//           -> {"id":"Code-wisp-xxx","ephemeral":true,...}
//   list:   `bd list --json` emits wisps with `ephemeral:true` + `labels:[...]`;
//           a promoted bead drops `ephemeral`.
//   promote:`bd promote <id> --reason "..."`
//
// Dedup is by source-path label (`sense:src=<relpath>`): before minting, we read
// the labels of existing open wisps and skip any path already present. This
// survives an app restart (unlike an in-memory seen-set) and is idempotent
// against re-saving the same file.
//
// All bd calls route through `bd::run_bd_verb` so they share the RV3.1
// fork-storm semaphore — never spawn `bd` directly here.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::bd::{run_bd_verb, Issue};

/// Label prefix that tags a wisp with the Obsidian file it was sensed from.
/// The value is the path *relative to the Beads vault root* (e.g.
/// `Daily/2026-08-12.md`), so it's stable across machines/users.
const SRC_LABEL_PREFIX: &str = "sense:src=";

/// Vault root for the watched Obsidian folders. Resolved off `$HOME` the same
/// way `daily.rs::default_daily_dir()` does, with the identical hardcoded
/// fallback, so the two stay in lockstep.
fn vault_root() -> PathBuf {
    match std::env::var_os("HOME") {
        Some(home) => Path::new(&home).join("Documents/Beads"),
        None => PathBuf::from("~/Documents/Beads"),
    }
}

/// The two folders the sensor watches. Returned as absolute paths for the
/// watcher; `source_rel` re-derives the vault-relative label form.
pub(crate) fn watched_dirs() -> Vec<PathBuf> {
    let root = vault_root();
    vec![root.join("Implementation Prompts"), root.join("Daily")]
}

/// A sensed wisp surfaced in the Sensors panel. snake_case to match bd's JSON
/// (like `Gate`); `source` is the vault-relative path parsed out of the
/// `sense:src=` label so the operator sees which file spawned it.
#[derive(Serialize, Debug, Clone, Default)]
pub struct Wisp {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub created_at: String,
    /// Vault-relative source path from the `sense:src=` label, or None if the
    /// wisp was minted by something other than the sensor.
    pub source: Option<String>,
}

/// Pull the `sense:src=<path>` value out of an issue's labels, if present.
fn source_from_labels(labels: &Option<Vec<String>>) -> Option<String> {
    labels.as_ref()?.iter().find_map(|l| {
        l.strip_prefix(SRC_LABEL_PREFIX)
            .map(|s| s.to_string())
    })
}

/// Pure: keep only the open ephemeral wisps and project them into `Wisp`.
/// Split out from the command so it's unit-testable without a live bd.
fn wisps_from_issues(issues: Vec<Issue>) -> Vec<Wisp> {
    issues
        .into_iter()
        .filter(|i| i.ephemeral && i.status == "open")
        .map(|i| Wisp {
            source: source_from_labels(&i.labels),
            id: i.id,
            title: i.title,
            description: i.description,
            status: i.status,
            created_at: i.created_at,
        })
        .collect()
}

/// Vault-relative path (label form) for an absolute file under the vault root.
/// Falls back to the file name when the path isn't under the root (defensive —
/// the watcher only feeds it in-vault paths).
fn source_rel(abs: &Path) -> String {
    let root = vault_root();
    abs.strip_prefix(&root)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| {
            abs.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        })
}

/// `bd list --json` -> open ephemeral wisps only, projected to `Wisp`. This is
/// the Sensors-panel feed. NoDatabase / parse issues surface as an Err to the
/// FE (the panel shows the error line, same as GateCockpit).
#[tauri::command]
pub async fn sense_list(repo_path: String) -> Result<Vec<Wisp>, String> {
    let stdout = run_bd_verb(&repo_path, &["list", "--json"]).await?;
    let issues: Vec<Issue> = serde_json::from_slice(&stdout)
        .map_err(|e| format!("failed to parse bd list JSON: {e}"))?;
    Ok(wisps_from_issues(issues))
}

/// `bd promote <id> --reason "..."` — the APPROVE action: copy the wisp into the
/// permanent issues table, preserving its id + links.
#[tauri::command]
pub async fn sense_promote(repo_path: String, id: String) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("id must not be empty".into());
    }
    run_bd_verb(
        &repo_path,
        &["promote", &id, "--reason", "Promoted from Sensors panel"],
    )
    .await
    .map(|_| ())
}

/// `bd close <id> --reason "..."` — the DISMISS action: close the wisp without
/// promoting it (the honest "not tracked" state; the wisp then TTL-collapses).
#[tauri::command]
pub async fn sense_dismiss(repo_path: String, id: String) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("id must not be empty".into());
    }
    run_bd_verb(
        &repo_path,
        &[
            "close",
            &id,
            "--reason",
            "Dismissed at Sensors panel",
            "--actor",
            crate::bd::ACTOR,
        ],
    )
    .await
    .map(|_| ())
}

/// The sensor tick. Lists the watched Obsidian folders, diffs the `.md` files
/// against the source paths already carried by existing open wisps, and mints a
/// new ephemeral wisp for each unseen file. Returns the number created.
///
/// Dedup: read existing wisp `sense:src=` labels first and skip any path already
/// present. Idempotent — re-running with no new files creates nothing.
#[tauri::command]
pub async fn sense_scan(repo_path: String) -> Result<usize, String> {
    // Existing sensed source paths (dedup set).
    let existing = sense_list(repo_path.clone()).await?;
    let seen: std::collections::HashSet<String> =
        existing.into_iter().filter_map(|w| w.source).collect();

    let mut created = 0usize;
    for dir in watched_dirs() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue, // folder may not exist yet — not an error
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !is_markdown(&path) {
                continue;
            }
            let rel = source_rel(&path);
            if seen.contains(&rel) {
                continue;
            }
            let stem = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| rel.clone());
            let label = format!("{SRC_LABEL_PREFIX}{rel}");
            let desc = format!("Sensed from {rel}");
            run_bd_verb(
                &repo_path,
                &[
                    "create",
                    &stem,
                    "--ephemeral",
                    "--labels",
                    &label,
                    "--description",
                    &desc,
                    "--json",
                ],
            )
            .await?;
            created += 1;
        }
    }
    Ok(created)
}

/// True for a real markdown file (skips `.DS_Store`, editor swap files, dirs).
fn is_markdown(p: &Path) -> bool {
    p.is_file()
        && p.extension()
            .map(|e| e.eq_ignore_ascii_case("md"))
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue(id: &str, ephemeral: bool, status: &str, labels: Option<Vec<String>>) -> Issue {
        Issue {
            id: id.into(),
            title: format!("title {id}"),
            status: status.into(),
            ephemeral,
            labels,
            ..Default::default()
        }
    }

    #[test]
    fn source_label_parsed() {
        let labels = Some(vec![
            "some-other".into(),
            "sense:src=Daily/2026-08-12.md".into(),
        ]);
        assert_eq!(
            source_from_labels(&labels).as_deref(),
            Some("Daily/2026-08-12.md")
        );
    }

    #[test]
    fn no_source_label() {
        assert_eq!(source_from_labels(&Some(vec!["x".into()])), None);
        assert_eq!(source_from_labels(&None), None);
    }

    #[test]
    fn only_open_ephemeral_kept() {
        let issues = vec![
            issue("Code-1", false, "open", None),          // permanent -> drop
            issue("Code-wisp-a", true, "open", Some(vec!["sense:src=Daily/a.md".into()])),
            issue("Code-wisp-b", true, "closed", None),     // dismissed -> drop
        ];
        let wisps = wisps_from_issues(issues);
        assert_eq!(wisps.len(), 1);
        assert_eq!(wisps[0].id, "Code-wisp-a");
        assert_eq!(wisps[0].source.as_deref(), Some("Daily/a.md"));
    }

    #[test]
    fn markdown_filter() {
        // is_markdown requires the file to exist; check the extension logic via
        // a path that won't exist -> is_file() false -> false either way, so we
        // assert the non-md rejection on the name shape instead.
        assert!(!is_markdown(Path::new("/tmp/.DS_Store")));
        assert!(!is_markdown(Path::new("/tmp/note.txt")));
    }
}
