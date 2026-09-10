//! Project discovery is read-only. Opening a folder explicitly remembers it
//! and allocates a provider session. No machine-specific paths.
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;
use uuid::Uuid;

const PROJECTS_STORE: &str = "projects.json";
const SETTINGS_STORE: &str = "workspace-settings.json";

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

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub projects: Vec<Project>,
    pub roots: Vec<String>,
    pub warnings: Vec<String>,
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|e| format!("HOME not set: {e}"))
}

fn expand_path(raw: &str) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("Enter a folder path.".into());
    }
    let path = if raw == "~" {
        home_dir()?
    } else if let Some(rest) = raw.strip_prefix("~/") {
        home_dir()?.join(rest)
    } else {
        PathBuf::from(raw)
    };
    if !path.is_absolute() {
        return Err("Use an absolute path or a path starting with ~/.".into());
    }
    Ok(path)
}

fn default_roots(home: &Path) -> Vec<String> {
    let desktop = home.join("Desktop/Code");
    let legacy = home.join("Code");
    let root = if desktop.is_dir() || !legacy.is_dir() {
        desktop
    } else {
        legacy
    };
    vec![root.to_string_lossy().into_owned()]
}

fn saved_paths(app: &AppHandle, key: &str) -> Result<Option<Vec<String>>, String> {
    let store = app.store(SETTINGS_STORE).map_err(|e| e.to_string())?;
    store
        .get(key)
        .map(|value| {
            serde_json::from_value(value).map_err(|e| format!("Invalid {key} settings: {e}"))
        })
        .transpose()
}

fn project_at(path: &Path) -> Result<Project, String> {
    let path = path
        .canonicalize()
        .map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    if !path.is_dir() {
        return Err(format!("{} is not a folder.", path.display()));
    }
    let name = path
        .file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned();
    let path_string = path.to_string_lossy().into_owned();
    // Canonical paths separate same-name repositories and dedupe symlinks.
    // The opaque ID is deterministic and safe in event channels, including
    // folders whose paths contain spaces. Discovery never mints a session.
    Ok(Project {
        id: Uuid::new_v5(
            &Uuid::NAMESPACE_URL,
            format!("beads-station:workspace:{path_string}").as_bytes(),
        )
        .to_string(),
        name,
        path: path_string,
        has_git: path.join(".git").exists(),
        has_beads: path.join(".beads").is_dir(),
        claude_session_id: String::new(),
    })
}

fn discover(roots: Vec<String>, folders: &[String]) -> Discovery {
    let mut warnings = Vec::new();
    let mut candidates = BTreeSet::new();
    for root in &roots {
        let entries = match std::fs::read_dir(root) {
            Ok(entries) => entries,
            Err(e) => {
                warnings.push(format!("{root}: {e}"));
                continue;
            }
        };
        for entry in entries {
            match entry {
                Ok(entry) => {
                    let path = entry.path();
                    if !entry.file_name().to_string_lossy().starts_with('.')
                        && path.join(".git").exists()
                    {
                        candidates.insert(path);
                    }
                }
                Err(e) => warnings.push(format!("{root}: {e}")),
            }
        }
    }
    candidates.extend(folders.iter().map(PathBuf::from));
    let mut seen = BTreeSet::new();
    let mut projects = Vec::new();
    for path in candidates {
        match project_at(&path) {
            Ok(project) if seen.insert(project.id.clone()) => projects.push(project),
            Ok(_) => {}
            Err(e) => warnings.push(e),
        }
    }
    projects.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.path.cmp(&b.path))
    });
    Discovery {
        projects,
        roots,
        warnings,
    }
}

fn scan_projects(app: &AppHandle) -> Result<Discovery, String> {
    let roots = match saved_paths(app, "roots")? {
        Some(roots) => roots,
        None => default_roots(&home_dir()?),
    };
    let folders = saved_paths(app, "folders")?.unwrap_or_default();
    let mut result = discover(roots, &folders);
    let sessions = app.store(PROJECTS_STORE).map_err(|e| e.to_string())?;
    for project in &mut result.projects {
        project.claude_session_id = sessions
            .get(&project.id)
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
    }
    Ok(result)
}

#[tauri::command]
pub async fn projects_list(app: AppHandle) -> Result<Discovery, String> {
    // Directory scans and store IO must not occupy the async command executor.
    tauri::async_runtime::spawn_blocking(move || scan_projects(&app))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn projects_set_roots(app: AppHandle, roots: Vec<String>) -> Result<Discovery, String> {
    let roots: Result<BTreeSet<String>, String> = roots
        .iter()
        .map(|s| expand_path(s).map(|p| p.to_string_lossy().into_owned()))
        .collect();
    let roots: Vec<_> = roots?.into_iter().collect();
    let store = app.store(SETTINGS_STORE).map_err(|e| e.to_string())?;
    store.set("roots", serde_json::json!(roots));
    store.save().map_err(|e| e.to_string())?;
    projects_list(app).await
}

#[tauri::command]
pub async fn projects_open(app: AppHandle, path: String) -> Result<Project, String> {
    tauri::async_runtime::spawn_blocking(move || open_project(&app, &path))
        .await
        .map_err(|e| e.to_string())?
}

fn open_project(app: &AppHandle, path: &str) -> Result<Project, String> {
    let mut project = project_at(&expand_path(&path)?)?;
    let sessions = app.store(PROJECTS_STORE).map_err(|e| e.to_string())?;
    let existing = sessions
        .get(&project.id)
        .or_else(|| sessions.get(&project.path))
        .and_then(|v| v.as_str().filter(|s| !s.is_empty()).map(str::to_owned));
    // Opening one known folder must not wait for an unrelated discovery root
    // (network mounts and macOS filesystem reads can stall indefinitely).
    // Basename-only IDs cannot prove workspace identity; preserve that record
    // without applying it to an arbitrary same-name checkout.
    project.claude_session_id = existing
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    sessions.set(&project.id, serde_json::json!(project.claude_session_id));
    sessions.save().map_err(|e| e.to_string())?;
    let mut folders = saved_paths(&app, "folders")?.unwrap_or_default();
    if !folders.contains(&project.path) {
        folders.push(project.path.clone());
        let settings = app.store(SETTINGS_STORE).map_err(|e| e.to_string())?;
        settings.set("folders", serde_json::json!(folders));
        settings.save().map_err(|e| e.to_string())?;
    }
    Ok(project)
}

#[tauri::command]
pub async fn projects_get(app: AppHandle, id: String) -> Result<Project, String> {
    projects_list(app)
        .await?
        .projects
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("Project '{id}' not found"))
}

#[tauri::command]
pub async fn projects_set_claude_session(
    app: AppHandle,
    id: String,
    session_id: String,
) -> Result<(), String> {
    let store = app.store(PROJECTS_STORE).map_err(|e| e.to_string())?;
    store.set(&id, serde_json::json!(session_id));
    store.save().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_roots_do_not_hide_valid_folders_and_names_do_not_collide() {
        let temp = std::env::temp_dir().join(format!("bs-projects-{}", Uuid::new_v4()));
        for side in ["one", "two"] {
            std::fs::create_dir_all(temp.join(side).join("same/.git")).unwrap();
        }
        let roots = ["one", "two", "missing"]
            .map(|s| temp.join(s).to_string_lossy().into_owned())
            .to_vec();
        let scan = discover(roots, &[]);
        assert_eq!(scan.projects.len(), 2);
        assert_ne!(scan.projects[0].id, scan.projects[1].id);
        assert_eq!(scan.warnings.len(), 1);
        assert!(scan.projects.iter().all(|p| p.claude_session_id.is_empty()));
        std::fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn explicit_folders_need_not_be_git_repositories_and_are_deduplicated() {
        let temp = std::env::temp_dir().join(format!("bs-folder-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let path = temp.to_string_lossy().into_owned();
        let scan = discover(vec![], &[path.clone(), path]);
        assert_eq!(scan.projects.len(), 1);
        assert!(!scan.projects[0].has_git);
        std::fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn suggests_desktop_code_on_fresh_machine_and_preserves_legacy_default() {
        let temp = std::env::temp_dir().join(format!("bs-roots-{}", Uuid::new_v4()));
        assert_eq!(
            default_roots(&temp),
            vec![temp.join("Desktop/Code").to_string_lossy().into_owned()]
        );
        std::fs::create_dir_all(temp.join("Code")).unwrap();
        assert_eq!(
            default_roots(&temp),
            vec![temp.join("Code").to_string_lossy().into_owned()]
        );
        std::fs::create_dir_all(temp.join("Desktop/Code")).unwrap();
        assert_eq!(
            default_roots(&temp),
            vec![temp.join("Desktop/Code").to_string_lossy().into_owned()]
        );
        std::fs::remove_dir_all(temp).unwrap();
    }
}
