// Beads Station — Phase 2 project scanner.
//
// Scans ~/Code for git repositories, augments the list with any
// repo declared under `repos.additional` in ~/Code/.beads/config.yaml,
// and persists a stable per-project Claude session UUID in the
// tauri-plugin-store keyed by project id.
//
// The store is a flat map: { "<project-id>": "<uuid-v4>" } saved to
// "projects.json" inside the app's plugin-store data dir.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;
use uuid::Uuid;

const PROJECTS_STORE: &str = "projects.json";

/// Hardcoded blocklist (directories under ~/Code that should never be
/// surfaced as projects). The brief lists kebab-case keys; the actual
/// on-disk names may differ in capitalisation or punctuation, so
/// matching is done against BOTH the literal name and a normalised key.
const BLOCKLIST: &[&str] = &[
    "AllDoors-May-12",
    "Carmen-FX-Layout-Fix",
    "claude-code-session",
    "MCP-Test",
];

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub has_git: bool,
    pub has_beads: bool,
    pub claude_session_id: String,
}

/// Lowercase + non-alphanumeric → '-' so blocklist matching survives
/// whitespace, capitalisation, and punctuation drift.
fn normalise_key(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_dash = false;
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

fn is_blocklisted(name: &str) -> bool {
    let norm = normalise_key(name);
    BLOCKLIST.iter().any(|b| {
        b == &name || normalise_key(b) == norm
    })
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|e| format!("HOME not set: {e}"))
}

fn code_root() -> Result<PathBuf, String> {
    Ok(home_dir()?.join("Code"))
}

/// `<dir>/.git` may be a directory (normal repo) or a file (worktree).
fn has_git(dir: &Path) -> bool {
    dir.join(".git").exists()
}

fn has_beads_dir(dir: &Path) -> bool {
    dir.join(".beads").is_dir()
}

/// Minimal hand-rolled parser for the `repos.additional` list in
/// ~/Code/.beads/config.yaml. Avoids pulling a yaml crate just for
/// two-line config. Returns absolute paths as written.
fn parse_additional_repos(config_path: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(config_path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut in_additional = false;
    for raw in text.lines() {
        let line = raw.trim_end();
        let trimmed = line.trim_start();
        if trimmed.starts_with("additional:") {
            in_additional = true;
            continue;
        }
        if !in_additional {
            continue;
        }
        // List items look like `    - "/path"` or `    - /path`.
        if let Some(rest) = trimmed.strip_prefix("- ") {
            let val = rest.trim().trim_matches('"').trim_matches('\'');
            if !val.is_empty() {
                out.push(val.to_string());
            }
            continue;
        }
        // Any non-list, non-blank line at the same or shallower indent
        // ends the list. (Blank lines are tolerated.)
        if !trimmed.is_empty() && !trimmed.starts_with('#') {
            break;
        }
    }
    out
}

/// Get-or-mint the Claude session UUID for a given project id. The
/// store is loaded once per call; callers iterating over many projects
/// should batch in a single function so writes share one .save().
fn get_or_mint_session_id(
    app: &AppHandle,
    id: &str,
) -> Result<(String, bool), String> {
    let store = app
        .store(PROJECTS_STORE)
        .map_err(|e| format!("open projects store: {e}"))?;

    if let Some(JsonValue::String(existing)) = store.get(id) {
        if !existing.is_empty() {
            return Ok((existing, false));
        }
    }

    let new_id = Uuid::new_v4().to_string();
    store.set(id, JsonValue::String(new_id.clone()));
    // RV3.7 (Code-1u9) — persist the mint immediately. The scan loop calls this
    // per project and only store.save()s once after both passes; a fallible `?`
    // between a mint and that final save would drop the freshly-minted UUID
    // from disk (still live in memory), so the next scan re-mints a different
    // id and breaks Claude session-id stability. Saving here (the plugin
    // batches writes) makes each mint durable regardless of later failures.
    store
        .save()
        .map_err(|e| format!("persist minted session id: {e}"))?;
    Ok((new_id, true))
}

fn build_project(
    app: &AppHandle,
    id: String,
    path: PathBuf,
    has_beads_extra: bool,
) -> Result<Project, String> {
    let path_str = path.to_string_lossy().to_string();
    let has_g = has_git(&path);
    let has_b = has_beads_dir(&path) || has_beads_extra;
    let (session_id, _minted) = get_or_mint_session_id(app, &id)?;
    Ok(Project {
        id: id.clone(),
        name: id,
        path: path_str,
        has_git: has_g,
        has_beads: has_b,
        claude_session_id: session_id,
    })
}

/// Core scanner shared by `projects_list` and `projects_get`. Returns
/// every eligible project plus the set of additional-repo paths so the
/// caller can decide whether to flag `has_beads = true` regardless of
/// the on-disk `.beads` dir.
fn scan_projects(app: &AppHandle) -> Result<Vec<Project>, String> {
    let root = code_root()?;
    let beads_config = root.join(".beads").join("config.yaml");
    let additional = parse_additional_repos(&beads_config);

    // Set of canonicalised additional paths for quick membership checks.
    let additional_canon: Vec<PathBuf> = additional
        .iter()
        .filter_map(|p| std::fs::canonicalize(p).ok())
        .collect();

    let mut projects: Vec<Project> = Vec::new();

    // Pass 1: scan ~/Code/* directly.
    let entries = std::fs::read_dir(&root)
        .map_err(|e| format!("read {}: {e}", root.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("dir entry: {e}"))?;
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        if is_blocklisted(&name) {
            continue;
        }
        // Phase 2.5: Claude CLI's session-id transcript path encoding
        // misbehaves on dirs with spaces — skip them until Phase 6 wires
        // the JSONL replay path. This drops 'All Doors',
        // 'AllDoors - May', 'AllDoors - May 12', 'Claude Code May Session',
        // 'Dev Tools for UX Designers', 'Intelligent Apps SAC',
        // 'Introductory Claude Session', 'UX Design Basics' from the tab list.
        // 'GitHub-Org-UE' has no space and is kept.
        if name.contains(' ') {
            continue;
        }
        if !has_git(&path) {
            continue;
        }

        // If this dir is also referenced by additional, mark beads true.
        let canon = std::fs::canonicalize(&path).ok();
        let in_additional = canon
            .as_ref()
            .map(|c| additional_canon.iter().any(|a| a == c))
            .unwrap_or(false);

        let project = build_project(app, name, path, in_additional)?;
        projects.push(project);
    }

    // Pass 2: include additional repos that live OUTSIDE ~/Code.
    for raw in &additional {
        let p = PathBuf::from(raw);
        let canon = match std::fs::canonicalize(&p) {
            Ok(c) => c,
            Err(_) => continue,
        };
        // Skip if already covered in pass 1 (under ~/Code).
        if canon.starts_with(&root) {
            continue;
        }
        if !has_git(&canon) {
            continue;
        }
        let id = match canon.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if is_blocklisted(&id) {
            continue;
        }
        // Phase 2.5: also skip space-bearing additional repos. The
        // session-id transcript-path quirk is the same regardless of
        // whether the repo lives under ~/Code or elsewhere.
        if id.contains(' ') {
            continue;
        }
        // additional → has_beads is implicitly true.
        let project = build_project(app, id, canon, true)?;
        projects.push(project);
    }

    // Persist any newly-minted UUIDs in a single save.
    let store = app
        .store(PROJECTS_STORE)
        .map_err(|e| format!("open projects store: {e}"))?;
    store
        .save()
        .map_err(|e| format!("save projects store: {e}"))?;

    projects.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(projects)
}

#[tauri::command]
pub async fn projects_list(app: AppHandle) -> Result<Vec<Project>, String> {
    scan_projects(&app)
}

#[tauri::command]
pub async fn projects_get(app: AppHandle, id: String) -> Result<Project, String> {
    let all = scan_projects(&app)?;
    all.into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("project '{id}' not found"))
}

#[tauri::command]
pub async fn projects_set_claude_session(
    app: AppHandle,
    id: String,
    session_id: String,
) -> Result<(), String> {
    let store = app
        .store(PROJECTS_STORE)
        .map_err(|e| format!("open projects store: {e}"))?;
    store.set(&id, JsonValue::String(session_id));
    store
        .save()
        .map_err(|e| format!("save projects store: {e}"))?;
    Ok(())
}
