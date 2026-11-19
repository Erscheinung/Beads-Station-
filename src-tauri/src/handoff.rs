// Offline handoff note and prompt journal (Code-7xc.2).
//
// No model call anywhere in here. A handoff is a markdown file the page builds
// from what Beads Station already knows (usage, the session file's prompts and
// plan, changed files) and this module only writes it, confined to a
// `Handoffs` folder. The prompt journal is the crash-safety net for long
// prompts: every prompt submitted in an agent pane is appended in full to a
// per-workspace file in the app data folder, rotated at 5 MB.
//
// The page never names a session file: it sends provider + id and the file is
// found by that id under the CLI's own folders.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Local};
use serde::Serialize;
use serde_json::Value;
use tauri::Manager;

use crate::session_usage::{find_claude_session, sha256_hex};
use crate::transcripts::{clean_user_text, codex_id, codex_rollouts, homes, is_codex_preamble, is_session_id, read_window};

const MAX_READ: u64 = 8 * 1024 * 1024;
const HEAD_READ: u64 = 1024 * 1024;
const MAX_NOTE_BYTES: usize = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES: usize = 200 * 1024;
const JOURNAL_ROTATE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_RECENT: usize = 20;
const MAX_TODOS: usize = 100;

// ---------- names ----------

/// A file-name-safe piece: lowercase letters, digits and single dashes, at most `max` long.
pub(crate) fn slug(text: &str, max: usize) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    let cut: String = trimmed.chars().take(max).collect();
    cut.trim_matches('-').to_string()
}

/// The workspace's folder name as a slug; "workspace" when nothing usable is left.
fn workspace_slug(workspace: &str) -> String {
    let last = workspace.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    let s = slug(last, 40);
    if s.is_empty() { "workspace".into() } else { s }
}

fn valid_provider(provider: &str) -> Result<&str, String> {
    match provider {
        "claude" | "codex" | "gemini" => Ok(provider),
        _ => Err("Unknown provider".into()),
    }
}

// ---------- handoff write ----------

/// Write `markdown` to `<root>/Handoffs/<YYYY-MM-DD-HHMM>-<workspace>-<provider>.md`. The name is
/// built only from sanitized parts, an existing file is never overwritten, and the write is
/// atomic (temp file in the same folder, then rename).
pub(crate) fn write_handoff(root: &Path, workspace: &str, provider: &str, markdown: &str, now: DateTime<Local>) -> Result<PathBuf, String> {
    valid_provider(provider)?;
    if markdown.trim().is_empty() { return Err("Nothing to write".into()) }
    if markdown.len() > MAX_NOTE_BYTES { return Err("Handoff is too large".into()) }
    if !root.is_absolute() { return Err("Notes folder must be an absolute path".into()) }
    let dir = root.join("Handoffs");
    fs::create_dir_all(&dir).map_err(|e| format!("create Handoffs folder: {e}"))?;
    // A symlinked Handoffs folder must not lead out of the notes folder.
    let canonical_root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let canonical_dir = fs::canonicalize(&dir).map_err(|e| e.to_string())?;
    if !canonical_dir.starts_with(&canonical_root) { return Err("Handoffs folder leaves the notes folder".into()) }

    let stem = format!("{}-{}-{}", now.format("%Y-%m-%d-%H%M"), workspace_slug(workspace), provider);
    let mut target = canonical_dir.join(format!("{stem}.md"));
    let mut n = 2;
    while target.exists() {
        target = canonical_dir.join(format!("{stem}-{n}.md"));
        n += 1;
        if n > 99 { return Err("Too many handoffs in one minute".into()) }
    }
    let temp = canonical_dir.join(format!(".{stem}.tmp"));
    let result = (|| -> std::io::Result<()> {
        let mut file = File::create(&temp)?;
        file.write_all(markdown.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temp, &target)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(format!("write handoff: {error}"));
    }
    Ok(target)
}

fn handoff_root(vault: Option<&str>) -> Result<PathBuf, String> {
    match vault.map(str::trim).filter(|v| !v.is_empty()) {
        Some(path) => {
            let expanded = crate::binresolve::expand_home(path).ok_or("HOME not set")?;
            if !expanded.is_absolute() { return Err("Vault folder must be an absolute path or start with ~/.".into()) }
            Ok(expanded)
        }
        None => crate::daily::notes_root(),
    }
}

/// Write a handoff note. `vault` is the Obsidian vault folder setting; empty means the notes folder.
#[tauri::command]
pub async fn handoff_write(workspace: String, provider: String, session_id: Option<String>, markdown: String, vault: Option<String>) -> Result<String, String> {
    if let Some(id) = &session_id { if !is_session_id(id) { return Err("Invalid session id".into()) } }
    tauri::async_runtime::spawn_blocking(move || {
        let root = handoff_root(vault.as_deref())?;
        write_handoff(&root, &workspace, &provider, &markdown, Local::now()).map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- collecting from a session file ----------

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub text: String,
    /// "pending", "in_progress" or "completed" (as the CLI wrote it; unknown values are kept).
    pub status: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct HandoffFacts {
    pub first_prompt: Option<String>,
    /// Oldest first, in full.
    pub recent_prompts: Vec<String>,
    pub todos: Vec<TodoItem>,
    /// True when the session file was longer than the read window, so older parts are not seen.
    pub truncated: bool,
}

fn claude_prompts(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v.get("type").and_then(Value::as_str) != Some("user") { continue }
        if v.get("isSidechain").and_then(Value::as_bool) == Some(true) || v.get("isMeta").and_then(Value::as_bool) == Some(true) { continue }
        let Some(content) = v.get("message").and_then(|m| m.get("content")) else { continue };
        let mut texts = Vec::new();
        match content {
            Value::String(raw) => texts.extend(clean_user_text(raw)),
            Value::Array(blocks) => {
                for b in blocks {
                    if b.get("type").and_then(Value::as_str) == Some("text") {
                        texts.extend(b.get("text").and_then(Value::as_str).and_then(clean_user_text));
                    }
                }
            }
            _ => {}
        }
        if !texts.is_empty() { out.push(texts.join("\n\n")) }
    }
    out
}

fn claude_todos(text: &str) -> Vec<TodoItem> {
    let mut latest: Vec<TodoItem> = Vec::new();
    for line in text.lines() {
        if !line.contains("TodoWrite") { continue }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v.get("isSidechain").and_then(Value::as_bool) == Some(true) { continue }
        let Some(blocks) = v.get("message").and_then(|m| m.get("content")).and_then(Value::as_array) else { continue };
        for b in blocks {
            if b.get("type").and_then(Value::as_str) != Some("tool_use") || b.get("name").and_then(Value::as_str) != Some("TodoWrite") { continue }
            let Some(items) = b.get("input").and_then(|i| i.get("todos")).and_then(Value::as_array) else { continue };
            latest = items.iter().filter_map(|t| {
                let text = t.get("content").and_then(Value::as_str)?.trim();
                if text.is_empty() { return None }
                Some(TodoItem { text: text.into(), status: t.get("status").and_then(Value::as_str).unwrap_or("pending").into() })
            }).take(MAX_TODOS).collect();
        }
    }
    latest
}

fn codex_prompts(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v.get("type").and_then(Value::as_str) != Some("response_item") { continue }
        let Some(p) = v.get("payload") else { continue };
        if p.get("type").and_then(Value::as_str) != Some("message") || p.get("role").and_then(Value::as_str) != Some("user") { continue }
        let texts: Vec<String> = p.get("content").and_then(Value::as_array).into_iter().flatten()
            .filter_map(|i| i.get("text").and_then(Value::as_str))
            .filter(|t| !t.trim().is_empty() && !is_codex_preamble(t))
            .map(|t| t.trim().to_string())
            .collect();
        if !texts.is_empty() { out.push(texts.join("\n\n")) }
    }
    out
}

fn codex_todos(text: &str) -> Vec<TodoItem> {
    let mut latest: Vec<TodoItem> = Vec::new();
    for line in text.lines() {
        if !line.contains("update_plan") { continue }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let Some(p) = v.get("payload") else { continue };
        if p.get("type").and_then(Value::as_str) != Some("function_call") || p.get("name").and_then(Value::as_str) != Some("update_plan") { continue }
        let args: Value = match p.get("arguments") {
            Some(Value::String(s)) => serde_json::from_str(s).unwrap_or(Value::Null),
            Some(other) => other.clone(),
            None => Value::Null,
        };
        let Some(items) = args.get("plan").and_then(Value::as_array) else { continue };
        latest = items.iter().filter_map(|t| {
            let text = t.get("step").and_then(Value::as_str)?.trim();
            if text.is_empty() { return None }
            Some(TodoItem { text: text.into(), status: t.get("status").and_then(Value::as_str).unwrap_or("pending").into() })
        }).take(MAX_TODOS).collect();
    }
    latest
}

/// Prompts, plan and goal of one session file. `recent` is clamped to 1..=20.
pub(crate) fn collect_from_file(path: &Path, provider: &str, recent: usize) -> Result<HandoffFacts, String> {
    let recent = recent.clamp(1, MAX_RECENT);
    let (tail, truncated) = read_window(path, MAX_READ, true).map_err(|e| e.to_string())?;
    let (prompts, todos) = if provider == "claude" { (claude_prompts(&tail), claude_todos(&tail)) } else { (codex_prompts(&tail), codex_todos(&tail)) };
    let first_prompt = if truncated {
        // The goal is at the start of the file, outside the tail window.
        let (head, _) = read_window(path, HEAD_READ, false).map_err(|e| e.to_string())?;
        let head_prompts = if provider == "claude" { claude_prompts(&head) } else { codex_prompts(&head) };
        head_prompts.into_iter().next()
    } else {
        prompts.first().cloned()
    };
    let start = prompts.len().saturating_sub(recent);
    Ok(HandoffFacts { first_prompt, recent_prompts: prompts[start..].to_vec(), todos, truncated })
}

fn session_file(provider: &str, id: &str) -> Result<PathBuf, String> {
    if !is_session_id(id) { return Err("Invalid session id".into()) }
    let (claude, codex) = homes()?;
    match provider {
        "claude" => find_claude_session(&claude, id),
        "codex" => codex_rollouts(&codex).into_iter().map(|(p, _)| p).find(|p| codex_id(p).as_deref() == Some(id)),
        _ => return Err("Only Claude and Codex sessions can be read".into()),
    }
    .ok_or_else(|| "That session file is gone".into())
}

/// The goal, newest prompts and plan of one exact session. Reads files only.
#[tauri::command]
pub async fn handoff_collect(provider: String, session_id: String, recent: Option<usize>) -> Result<HandoffFacts, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = session_file(&provider, &session_id)?;
        collect_from_file(&path, &provider, recent.unwrap_or(5))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- prompt journal ----------

/// `<dir>/<workspace-name>-<8 hex of the path's hash>.md`: readable, and two folders with one name stay apart.
fn journal_file(dir: &Path, workspace: &str) -> PathBuf {
    let hash = sha256_hex(workspace.as_bytes());
    dir.join(format!("{}-{}.md", workspace_slug(workspace), &hash[..8]))
}

pub(crate) fn append_journal(dir: &Path, workspace: &str, provider: &str, text: &str, now: DateTime<Local>, rotate_at: u64) -> Result<PathBuf, String> {
    valid_provider(provider)?;
    let text = text.trim();
    if text.is_empty() { return Err("Empty prompt".into()) }
    if text.len() > MAX_PROMPT_BYTES { return Err("Prompt is too large to journal".into()) }
    fs::create_dir_all(dir).map_err(|e| format!("create journal folder: {e}"))?;
    let path = journal_file(dir, workspace);
    let entry = format!("## {} · {}\n\n{}\n\n", now.format("%Y-%m-%d %H:%M:%S"), provider, text);
    let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if size > 0 && size + entry.len() as u64 > rotate_at {
        let old = PathBuf::from(format!("{}.1", path.to_string_lossy()));
        fs::rename(&path, &old).map_err(|e| format!("rotate journal: {e}"))?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(&path).map_err(|e| format!("open journal: {e}"))?;
    file.write_all(entry.as_bytes()).map_err(|e| format!("write journal: {e}"))?;
    Ok(path)
}

fn journal_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| format!("app data directory: {e}"))?.join("prompt-journal"))
}

/// Append one submitted prompt, in full, to the workspace's journal.
#[tauri::command]
pub async fn journal_append(app: tauri::AppHandle, workspace: String, provider: String, text: String) -> Result<(), String> {
    let dir = journal_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || append_journal(&dir, &workspace, &provider, &text, Local::now(), JOURNAL_ROTATE_BYTES).map(|_| ()))
        .await
        .map_err(|e| e.to_string())?
}

/// Where the workspace's journal is (it may not exist yet).
#[tauri::command]
pub fn journal_path(app: tauri::AppHandle, workspace: String) -> Result<String, String> {
    Ok(journal_file(&journal_dir(&app)?, &workspace).to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bs-handoff-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn slugs_are_file_safe() {
        assert_eq!(slug("../../Evil Dir/..", 40), "evil-dir");
        assert_eq!(workspace_slug("/home/dev/My App!"), "my-app");
        assert_eq!(workspace_slug("/"), "workspace");
        assert_eq!(workspace_slug("/x/.."), "workspace");
    }

    #[test]
    fn handoff_is_written_atomically_inside_handoffs_and_never_overwrites() {
        let root = scratch();
        let now = Local::now();
        let a = write_handoff(&root, "/home/dev/../../etc/passwd", "claude", "# note", now).unwrap();
        let b = write_handoff(&root, "/home/dev/../../etc/passwd", "claude", "# again", now).unwrap();
        assert_ne!(a, b);
        let canonical = fs::canonicalize(&root).unwrap().join("Handoffs");
        assert!(a.starts_with(&canonical));
        assert_eq!(fs::read_to_string(&a).unwrap(), "# note");
        let name = a.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.ends_with("-passwd-claude.md"), "{name}");
        assert!(fs::read_dir(&canonical).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().ends_with(".tmp")));
        assert!(write_handoff(&root, "/x", "../evil", "# n", now).is_err());
        assert!(write_handoff(&root, "/x", "claude", "  ", now).is_err());
        assert!(write_handoff(Path::new("relative"), "/x", "claude", "# n", now).is_err());
    }

    #[test]
    fn a_symlinked_handoffs_folder_cannot_lead_out() {
        let root = scratch();
        let outside = scratch();
        std::os::unix::fs::symlink(&outside, root.join("Handoffs")).unwrap();
        assert!(write_handoff(&root, "/x", "claude", "# n", Local::now()).is_err());
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    }

    fn claude_fixture() -> String {
        [
            r##"{"type":"user","message":{"role":"user","content":"Build the settings page <system-reminder>noise</system-reminder>"}}"##,
            r##"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"TodoWrite","input":{"todos":[{"content":"Old item","status":"pending"}]}}]}}"##,
            r##"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"##,
            r##"{"type":"user","isSidechain":true,"message":{"content":"subagent prompt"}}"##,
            r##"{"type":"user","message":{"content":[{"type":"text","text":"Second prompt\nwith two lines"}]}}"##,
            r##"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"TodoWrite","input":{"todos":[{"content":"Wire form","status":"completed"},{"content":"Add tests","status":"in_progress"}]}}]}}"##,
            r##"{"type":"user","message":{"content":"Third"}}"##,
        ].join("\n")
    }

    #[test]
    fn claude_prompts_come_in_full_and_the_latest_todo_list_wins() {
        let dir = scratch();
        let file = dir.join("s.jsonl");
        fs::write(&file, claude_fixture()).unwrap();
        let facts = collect_from_file(&file, "claude", 2).unwrap();
        assert_eq!(facts.first_prompt.as_deref(), Some("Build the settings page"));
        assert_eq!(facts.recent_prompts, vec!["Second prompt\nwith two lines".to_string(), "Third".to_string()]);
        assert_eq!(facts.todos, vec![TodoItem { text: "Wire form".into(), status: "completed".into() }, TodoItem { text: "Add tests".into(), status: "in_progress".into() }]);
        assert!(!facts.truncated);
    }

    #[test]
    fn codex_prompts_skip_preamble_and_update_plan_is_read() {
        let dir = scratch();
        let file = dir.join("r.jsonl");
        let lines = [
            r##"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>cwd</environment_context>"}]}}"##,
            r##"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Add a dark mode toggle"}]}}"##,
            r##"{"type":"response_item","payload":{"type":"function_call","name":"update_plan","call_id":"p","arguments":"{\"plan\":[{\"step\":\"Edit theme\",\"status\":\"completed\"},{\"step\":\"Verify\",\"status\":\"pending\"}]}"}}"##,
            r##"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Now the tests"}]}}"##,
        ].join("\n");
        fs::write(&file, lines).unwrap();
        let facts = collect_from_file(&file, "codex", 5).unwrap();
        assert_eq!(facts.first_prompt.as_deref(), Some("Add a dark mode toggle"));
        assert_eq!(facts.recent_prompts.len(), 2);
        assert_eq!(facts.todos.len(), 2);
        assert_eq!(facts.todos[1], TodoItem { text: "Verify".into(), status: "pending".into() });
    }

    #[test]
    fn a_huge_session_still_yields_its_first_prompt_from_the_head() {
        let dir = scratch();
        let file = dir.join("big.jsonl");
        let filler = format!(r##"{{"type":"user","message":{{"content":"{}"}}}}"##, "x".repeat(10_000));
        let mut text = String::from(r##"{"type":"user","message":{"content":"The goal"}}"##);
        for _ in 0..900 { text.push('\n'); text.push_str(&filler); }
        fs::write(&file, text).unwrap();
        let facts = collect_from_file(&file, "claude", 1).unwrap();
        assert!(facts.truncated);
        assert_eq!(facts.first_prompt.as_deref(), Some("The goal"));
        assert_eq!(facts.recent_prompts.len(), 1);
    }

    #[test]
    fn journal_appends_in_full_and_rotates_keeping_one_old_file() {
        let dir = scratch().join("prompt-journal");
        let now = Local::now();
        let long = "line\n".repeat(500);
        let path = append_journal(&dir, "/home/dev/app", "claude", &long, now, 4000).unwrap();
        append_journal(&dir, "/home/dev/app", "codex", "short", now, 4000).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains(long.trim()) && text.contains("· codex") && text.contains("short"));
        // The next long entry pushes past the limit: the file rotates and holds only the newest.
        append_journal(&dir, "/home/dev/app", "claude", &long, now, 4000).unwrap();
        let rotated = PathBuf::from(format!("{}.1", path.to_string_lossy()));
        assert!(rotated.exists());
        assert_eq!(fs::read_to_string(&path).unwrap().matches("## ").count(), 1);
        append_journal(&dir, "/home/dev/app", "claude", &long, now, 4000).unwrap();
        append_journal(&dir, "/home/dev/app", "claude", &long, now, 4000).unwrap();
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2, "only one .1 is kept");
        // Same folder name elsewhere is a different file.
        let other = append_journal(&dir, "/home/other/app", "claude", "x", now, 4000).unwrap();
        assert_ne!(other, path);
        assert!(append_journal(&dir, "/x", "bash", "x", now, 4000).is_err());
        assert!(append_journal(&dir, "/x", "claude", "  ", now, 4000).is_err());
    }
}
