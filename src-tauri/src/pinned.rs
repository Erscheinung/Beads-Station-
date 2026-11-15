//! Designer "Pinned" support: stat pinned references, open them with the
//! system, and read an Obsidian vault (a folder of markdown notes) read-only.
//!
//! Everything here is bounded and never writes. Vault reads are confined to the
//! vault folder: a note is addressed by a path relative to it, absolute paths
//! and `..` are refused, and the canonical result must still sit inside the
//! canonical vault (so a symlink inside the vault cannot lead out of it).

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

use serde::Serialize;

const MAX_NOTES: usize = 3000;
const MAX_DEPTH: usize = 10;
const MAX_NOTE_BYTES: usize = 512 * 1024;
const MAX_STAT_PATHS: usize = 64;

fn expand_home(path: &str) -> PathBuf {
    if path == "~" || path.starts_with("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return Path::new(&home).join(path.trim_start_matches('~').trim_start_matches('/'));
        }
    }
    PathBuf::from(path)
}

/// "dir", "file" or "missing" for each path, in order. Symlinks are followed
/// by the stat, which only tells a folder from a file; nothing is read.
#[tauri::command]
pub fn pin_kinds(paths: Vec<String>) -> Vec<String> {
    paths
        .iter()
        .take(MAX_STAT_PATHS)
        .map(|raw| match fs::metadata(expand_home(raw)) {
            Ok(meta) if meta.is_dir() => "dir",
            Ok(_) => "file",
            Err(_) => "missing",
        })
        .map(String::from)
        .collect()
}

/// Things `open` would launch or install rather than show: reveal them instead.
fn runs_code(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref(),
        Some("app" | "command" | "tool" | "sh" | "pkg" | "dmg" | "workflow" | "scpt" | "terminal" | "jar" | "webloc")
    )
}

/// Open a pinned file or folder with the system (Finder, or the file's default
/// app). Programs and installers are revealed in Finder, never launched.
#[tauri::command]
pub fn pin_open(path: String) -> Result<(), String> {
    let target = expand_home(&path);
    if !target.exists() {
        return Err(format!("{path} no longer exists"));
    }
    let reveal = target.is_file() && runs_code(&target) || target.is_dir() && runs_code(&target);
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("/usr/bin/open");
        if reveal {
            command.arg("-R");
        }
        command.arg("--").arg(&target);
        command
    };
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = Command::new("xdg-open");
        let shown = if reveal { target.parent().unwrap_or(&target).to_path_buf() } else { target.clone() };
        command.arg(shown);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer");
        if reveal {
            command.arg("/select,");
        }
        command.arg(&target);
        command
    };
    command.spawn().map(|_| ()).map_err(|e| format!("open: {e}"))
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultNote {
    /// Path relative to the vault, with `/` separators.
    pub rel: String,
    pub name: String,
    pub modified_ms: u64,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultList {
    pub notes: Vec<VaultNote>,
    pub truncated: bool,
}

fn vault_root(vault: &str) -> Result<PathBuf, String> {
    let root = expand_home(vault.trim());
    let canonical = root.canonicalize().map_err(|_| "The vault folder does not exist.".to_string())?;
    if !canonical.is_dir() {
        return Err("The vault path is not a folder.".into());
    }
    Ok(canonical)
}

fn walk(dir: &Path, root: &Path, depth: usize, out: &mut Vec<VaultNote>, truncated: &mut bool) {
    if depth > MAX_DEPTH || *truncated {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // Hidden folders hold Obsidian's own state (.obsidian, .trash) or VCS data.
        if name.starts_with('.') {
            continue;
        }
        // file_type() does not follow symlinks: a link is neither listed nor entered.
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        if kind.is_dir() {
            walk(&path, root, depth + 1, out, truncated);
        } else if kind.is_file() && name.to_ascii_lowercase().ends_with(".md") {
            if out.len() >= MAX_NOTES {
                *truncated = true;
                return;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let Ok(rel) = path.strip_prefix(root) else { continue };
            out.push(VaultNote {
                rel: rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"),
                name: name.trim_end_matches(".md").trim_end_matches(".MD").to_string(),
                modified_ms: meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0),
                size: meta.len(),
            });
        }
    }
}

fn list_notes(vault: &str) -> Result<VaultList, String> {
    let root = vault_root(vault)?;
    let mut notes = Vec::new();
    let mut truncated = false;
    walk(&root, &root, 0, &mut notes, &mut truncated);
    notes.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| a.rel.cmp(&b.rel)));
    Ok(VaultList { notes, truncated })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultNoteContent {
    pub rel: String,
    pub content: String,
    pub truncated: bool,
}

fn read_note(vault: &str, rel: &str) -> Result<VaultNoteContent, String> {
    let root = vault_root(vault)?;
    let relative = Path::new(rel);
    if rel.is_empty() || relative.is_absolute() || relative.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("That is not a note path inside the vault.".into());
    }
    if !rel.to_ascii_lowercase().ends_with(".md") {
        return Err("Only markdown notes can be read from the vault.".into());
    }
    let full = root.join(relative).canonicalize().map_err(|_| "That note does not exist.".to_string())?;
    if !full.starts_with(&root) || !full.is_file() {
        return Err("That note is outside the vault.".into());
    }
    let mut buffer = Vec::new();
    fs::File::open(&full)
        .and_then(|file| file.take(MAX_NOTE_BYTES as u64 + 1).read_to_end(&mut buffer))
        .map_err(|e| format!("read note: {e}"))?;
    let truncated = buffer.len() > MAX_NOTE_BYTES;
    buffer.truncate(MAX_NOTE_BYTES);
    Ok(VaultNoteContent { rel: rel.to_string(), content: String::from_utf8_lossy(&buffer).into_owned(), truncated })
}

/// Markdown notes in the vault, newest first. Read-only; skips hidden folders and symlinks.
#[tauri::command]
pub async fn vault_list(vault: String) -> Result<VaultList, String> {
    tauri::async_runtime::spawn_blocking(move || list_notes(&vault)).await.map_err(|e| e.to_string())?
}

/// One note's text (at most 512 KiB), addressed relative to the vault.
#[tauri::command]
pub async fn vault_read(vault: String, rel: String) -> Result<VaultNoteContent, String> {
    tauri::async_runtime::spawn_blocking(move || read_note(&vault, &rel)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bs-pinned-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn lists_markdown_only_and_skips_hidden_folders() {
        let vault = scratch("list");
        fs::create_dir_all(vault.join("Daily")).unwrap();
        fs::create_dir_all(vault.join(".obsidian")).unwrap();
        fs::write(vault.join("Daily/2026-01-01.md"), "# day").unwrap();
        fs::write(vault.join("Idea.md"), "idea").unwrap();
        fs::write(vault.join("pic.png"), [0u8]).unwrap();
        fs::write(vault.join(".obsidian/workspace.md"), "x").unwrap();
        let mut rels: Vec<_> = list_notes(vault.to_str().unwrap()).unwrap().notes.into_iter().map(|n| n.rel).collect();
        rels.sort();
        assert_eq!(rels, vec!["Daily/2026-01-01.md", "Idea.md"]);
    }

    #[test]
    fn refuses_traversal_absolute_paths_and_non_markdown() {
        let vault = scratch("trav");
        fs::write(vault.join("a.md"), "ok").unwrap();
        let outside = vault.with_extension("outside.md");
        fs::write(&outside, "secret").unwrap();
        let v = vault.to_str().unwrap();
        assert_eq!(read_note(v, "a.md").unwrap().content, "ok");
        assert!(read_note(v, "../x.md").is_err());
        assert!(read_note(v, outside.to_str().unwrap()).is_err());
        assert!(read_note(v, "a.txt").is_err());
        assert!(read_note(v, "").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_inside_the_vault_cannot_lead_out() {
        let vault = scratch("link");
        let outside = vault.with_extension("outside.md");
        fs::write(&outside, "secret").unwrap();
        std::os::unix::fs::symlink(&outside, vault.join("leak.md")).unwrap();
        assert!(read_note(vault.to_str().unwrap(), "leak.md").is_err());
        assert!(list_notes(vault.to_str().unwrap()).unwrap().notes.is_empty());
    }

    #[test]
    fn long_notes_are_cut() {
        let vault = scratch("big");
        fs::write(vault.join("big.md"), vec![b'a'; MAX_NOTE_BYTES + 10]).unwrap();
        let note = read_note(vault.to_str().unwrap(), "big.md").unwrap();
        assert!(note.truncated);
        assert_eq!(note.content.len(), MAX_NOTE_BYTES);
    }

    #[test]
    fn kinds_tell_folders_from_files() {
        let dir = scratch("kinds");
        fs::write(dir.join("f.txt"), "x").unwrap();
        let kinds = pin_kinds(vec![dir.to_string_lossy().into(), dir.join("f.txt").to_string_lossy().into(), dir.join("nope").to_string_lossy().into()]);
        assert_eq!(kinds, vec!["dir", "file", "missing"]);
    }
}
