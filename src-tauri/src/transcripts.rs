// Designer Desk (Code-05b.1): read-only transcripts of the agent CLIs' own
// session files.
//
// Claude Code writes `~/.claude/projects/<slug>/<session>.jsonl` and Codex
// writes `~/.codex/sessions/Y/M/D/rollout-<time>-<id>.jsonl`. This module only
// reads them: it never starts a model turn, never writes, and never returns a
// file path to the page. The page names a session by (provider, id) and the id
// is matched against file names we listed ourselves, so it cannot be used to
// read an arbitrary file. Reads are bounded (head for titles, tail for the
// conversation) so a multi-hundred-MB session cannot stall the app.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

/// The newest part of a session file that is parsed into turns.
const MAX_READ: u64 = 8 * 1024 * 1024;
/// How much of a file's start is looked at for its first prompt and workspace.
const HEAD_READ: u64 = 256 * 1024;
/// How much of a file's end is looked at for the latest generated title.
const TITLE_TAIL: u64 = 64 * 1024;
const MAX_LIST: usize = 60;
/// Codex keeps every workspace's rollouts together, so only the newest are scanned.
const MAX_CODEX_SCAN: usize = 150;
const PREVIEW_CHARS: usize = 400;
const TITLE_CHARS: usize = 90;
const PROMPT_CHARS: usize = 600;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSummary {
    pub id: String,
    pub provider: String,
    pub title: String,
    /// The opening prompt (clipped). Ticket sessions open with the ticket id, which is how a ticket finds its sessions.
    pub first_prompt: String,
    pub modified_ms: u64,
    pub bytes: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Block {
    Text { text: String },
    Tool { name: String, summary: String, result: Option<String> },
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub role: String,
    pub at: Option<String>,
    pub blocks: Vec<Block>,
    /// Files this turn's tools edited or wrote.
    pub files: Vec<String>,
    /// Reasoning blocks that were not shown (their text is not rendered).
    pub thinking: u32,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_create: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub id: String,
    pub provider: String,
    pub turns: Vec<Turn>,
    /// True when the file was larger than the read window and older turns are not shown.
    pub truncated: bool,
    /// Summed from the file's own usage fields. None when the file has none.
    pub usage: Option<Usage>,
}

// ---------- file helpers ----------

pub(crate) fn read_window(path: &Path, cap: u64, from_end: bool) -> std::io::Result<(String, bool)> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let cut = len > cap;
    let start = if from_end && cut { len - cap } else { 0 };
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(cap).read_to_end(&mut bytes)?;
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if cut {
        // A window that begins or ends mid-record has a partial line at that edge.
        if from_end {
            text = text.split_once('\n').map(|(_, rest)| rest.to_string()).unwrap_or_default();
        } else if let Some(index) = text.rfind('\n') {
            text.truncate(index);
        }
    }
    Ok((text, cut))
}

pub(crate) fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn is_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn clip(text: &str, max: usize) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        format!("{}…", flat.chars().take(max).collect::<String>())
    }
}

fn clip_keep_lines(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        trimmed.to_string()
    } else {
        format!("{}…", trimmed.chars().take(max).collect::<String>())
    }
}

/// Claude names a project folder after the path with every non-alphanumeric character turned into `-`.
fn claude_slug(workspace: &str) -> String {
    workspace.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

fn claude_dir(claude_home: &Path, workspace: &str) -> PathBuf {
    claude_home.join("projects").join(claude_slug(workspace))
}

fn jsonl_files(dir: &Path) -> Vec<(PathBuf, u64)> {
    let mut files: Vec<(PathBuf, u64)> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
        .map(|path| { let modified = modified_ms(&path); (path, modified) })
        .collect();
    files.sort_by(|a, b| b.1.cmp(&a.1));
    files
}

// ---------- text cleanup ----------

/// A user message as the person typed it: injected reminders and local-command
/// plumbing are removed. None when nothing readable is left.
fn clean_user_text(raw: &str) -> Option<String> {
    let mut text = raw.to_string();
    while let (Some(start), Some(end)) = (text.find("<system-reminder>"), text.find("</system-reminder>")) {
        if end < start { break }
        text.replace_range(start..end + "</system-reminder>".len(), "");
    }
    let text = text.trim();
    if text.is_empty() || text.starts_with("<local-command") || text.starts_with("Caveat: The messages below") {
        return None;
    }
    if let (Some(start), Some(end)) = (text.find("<command-name>"), text.find("</command-name>")) {
        if start < end {
            let name = &text[start + "<command-name>".len()..end];
            let args = text
                .split_once("<command-args>")
                .and_then(|(_, rest)| rest.split_once("</command-args>"))
                .map(|(args, _)| args.trim())
                .unwrap_or("");
            return Some(if args.is_empty() { name.to_string() } else { format!("{name} {args}") });
        }
    }
    Some(text.to_string())
}

fn is_codex_preamble(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("<environment_context>") || t.starts_with("<user_instructions>") || t.starts_with("# AGENTS.md") || t.starts_with("<permissions") || t.starts_with("<INSTRUCTIONS>")
}

fn tool_summary(input: &Value) -> String {
    if let Some(object) = input.as_object() {
        for key in ["command", "cmd", "file_path", "path", "pattern", "url", "query", "description", "prompt"] {
            if let Some(Value::String(text)) = object.get(key) {
                return clip(text, 140);
            }
            if let Some(Value::Array(parts)) = object.get(key) {
                let joined = parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ");
                if !joined.is_empty() { return clip(&joined, 140) }
            }
        }
    }
    String::new()
}

/// Codex "code mode" tool calls carry a JavaScript snippet such as
/// `await tools.exec_command({cmd:"git status"})`. The command is what a reader
/// wants to see, so lift the first `cmd` string literal out of it.
fn js_command(input: &str) -> Option<String> {
    let start = input.find("cmd")? + 3;
    let rest = input[start..].trim_start().strip_prefix(':')?.trim_start();
    let quote = rest.chars().next().filter(|c| matches!(c, '"' | '\'' | '`'))?;
    let mut out = String::new();
    let mut chars = rest[1..].chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(other) => out.push(other),
                None => break,
            },
            c if c == quote => return (!out.is_empty()).then_some(out),
            c => out.push(c),
        }
    }
    (!out.is_empty()).then_some(out)
}

fn edited_file(name: &str, input: &Value) -> Option<String> {
    if !matches!(name, "Edit" | "Write" | "MultiEdit" | "NotebookEdit") { return None }
    ["file_path", "notebook_path"].iter().find_map(|key| input.get(*key).and_then(Value::as_str)).map(str::to_string)
}

fn result_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts.iter().filter_map(|part| part.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

fn push_file(turn: &mut Turn, file: String) {
    if !turn.files.contains(&file) { turn.files.push(file) }
}

fn new_turn(role: &str, at: Option<String>) -> Turn {
    Turn { role: role.into(), at, blocks: Vec::new(), files: Vec::new(), thinking: 0 }
}

// ---------- Claude ----------

pub(crate) fn parse_claude(text: &str) -> (Vec<Turn>, Option<Usage>) {
    let mut turns: Vec<Turn> = Vec::new();
    // tool_use id -> (turn index, block index), so a later result lands on its call.
    let mut calls: HashMap<String, (usize, usize)> = HashMap::new();
    // One assistant message is written as several lines that repeat its usage.
    let mut usage_by_message: HashMap<String, Usage> = HashMap::new();

    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else { continue };
        if value.get("isSidechain").and_then(Value::as_bool) == Some(true) { continue }
        let at = value.get("timestamp").and_then(Value::as_str).map(str::to_string);
        let Some(message) = value.get("message") else { continue };
        match value.get("type").and_then(Value::as_str) {
            Some("user") => {
                let mut texts: Vec<String> = Vec::new();
                match message.get("content") {
                    Some(Value::String(raw)) => texts.extend(clean_user_text(raw)),
                    Some(Value::Array(blocks)) => {
                        for block in blocks {
                            match block.get("type").and_then(Value::as_str) {
                                Some("text") => texts.extend(block.get("text").and_then(Value::as_str).and_then(clean_user_text)),
                                Some("tool_result") => {
                                    let id = block.get("tool_use_id").and_then(Value::as_str).unwrap_or_default();
                                    if let Some(&(turn, index)) = calls.get(id) {
                                        if let Some(Block::Tool { result, .. }) = turns.get_mut(turn).and_then(|t| t.blocks.get_mut(index)) {
                                            *result = Some(clip_keep_lines(&result_text(block.get("content").unwrap_or(&Value::Null)), PREVIEW_CHARS));
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
                if !texts.is_empty() {
                    let mut turn = new_turn("user", at);
                    turn.blocks = texts.into_iter().map(|text| Block::Text { text }).collect();
                    turns.push(turn);
                }
            }
            Some("assistant") => {
                if let Some(usage) = message.get("usage") {
                    let id = message.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                    let field = |name: &str| usage.get(name).and_then(Value::as_u64).unwrap_or(0);
                    let entry = usage_by_message.entry(id).or_default();
                    entry.input = entry.input.max(field("input_tokens"));
                    entry.output = entry.output.max(field("output_tokens"));
                    entry.cache_read = entry.cache_read.max(field("cache_read_input_tokens"));
                    entry.cache_create = entry.cache_create.max(field("cache_creation_input_tokens"));
                }
                if !matches!(turns.last(), Some(turn) if turn.role == "assistant") {
                    turns.push(new_turn("assistant", at));
                }
                let index = turns.len() - 1;
                let Some(blocks) = message.get("content").and_then(Value::as_array) else { continue };
                for block in blocks {
                    match block.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            let text = block.get("text").and_then(Value::as_str).unwrap_or_default().trim();
                            if !text.is_empty() { turns[index].blocks.push(Block::Text { text: text.to_string() }) }
                        }
                        Some("thinking") => turns[index].thinking += 1,
                        Some("tool_use") => {
                            let name = block.get("name").and_then(Value::as_str).unwrap_or("tool").to_string();
                            let input = block.get("input").unwrap_or(&Value::Null);
                            if let Some(file) = edited_file(&name, input) { push_file(&mut turns[index], file) }
                            if let Some(id) = block.get("id").and_then(Value::as_str) {
                                calls.insert(id.to_string(), (index, turns[index].blocks.len()));
                            }
                            turns[index].blocks.push(Block::Tool { name, summary: tool_summary(input), result: None });
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    turns.retain(|turn| !turn.blocks.is_empty() || turn.thinking > 0);
    let usage = if usage_by_message.is_empty() {
        None
    } else {
        Some(usage_by_message.values().fold(Usage::default(), |sum, u| Usage {
            input: sum.input + u.input,
            output: sum.output + u.output,
            cache_read: sum.cache_read + u.cache_read,
            cache_create: sum.cache_create + u.cache_create,
        }))
    };
    (turns, usage)
}

fn claude_first_prompt(head: &str) -> Option<String> {
    head.lines().find_map(|line| {
        let value: Value = serde_json::from_str(line).ok()?;
        if value.get("type").and_then(Value::as_str) != Some("user") || value.get("isSidechain").and_then(Value::as_bool) == Some(true) { return None }
        let content = value.get("message")?.get("content")?;
        let raw = match content {
            Value::String(text) => text.clone(),
            Value::Array(blocks) => blocks.iter().find_map(|b| (b.get("type").and_then(Value::as_str) == Some("text")).then(|| b.get("text").and_then(Value::as_str)).flatten())?.to_string(),
            _ => return None,
        };
        clean_user_text(&raw).map(|text| clip(&text, PROMPT_CHARS))
    })
}

fn claude_title(head: &str, tail: &str, first_prompt: &str) -> Option<String> {
    let generated = tail.lines().rev().chain(head.lines().rev()).find_map(|line| {
        if !line.contains("\"ai-title\"") { return None }
        serde_json::from_str::<Value>(line).ok()?.get("aiTitle").and_then(Value::as_str).map(str::to_string)
    });
    if let Some(title) = generated { return Some(clip(&title, TITLE_CHARS)) }
    (!first_prompt.is_empty()).then(|| clip(first_prompt, TITLE_CHARS))
}

fn list_claude(claude_home: &Path, workspace: &str) -> Vec<TranscriptSummary> {
    jsonl_files(&claude_dir(claude_home, workspace))
        .into_iter()
        .filter_map(|(path, modified)| {
            let id = path.file_stem()?.to_str()?.to_string();
            if !is_session_id(&id) { return None }
            let (head, _) = read_window(&path, HEAD_READ, false).ok()?;
            let (tail, _) = read_window(&path, TITLE_TAIL, true).unwrap_or_default();
            // Sessions that never got a readable user prompt (hook-only or empty) are noise.
            let first_prompt = claude_first_prompt(&head).unwrap_or_default();
            let title = claude_title(&head, &tail, &first_prompt)?;
            Some(TranscriptSummary { id, provider: "claude".into(), title, first_prompt, modified_ms: modified, bytes: fs::metadata(&path).map(|m| m.len()).unwrap_or(0) })
        })
        .take(MAX_LIST)
        .collect()
}

// ---------- Codex ----------

pub(crate) fn codex_rollouts(codex_home: &Path) -> Vec<(PathBuf, u64)> {
    let sessions = codex_home.join("sessions");
    let newest_first = |dir: &Path| -> Vec<PathBuf> {
        let mut entries: Vec<PathBuf> = fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).collect();
        entries.sort();
        entries.reverse();
        entries
    };
    let mut files = Vec::new();
    for year in newest_first(&sessions) {
        for month in newest_first(&year) {
            for day in newest_first(&month) {
                for file in newest_first(&day) {
                    let name = file.file_name().and_then(|n| n.to_str()).unwrap_or_default();
                    if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                        let modified = modified_ms(&file);
                        files.push((file, modified));
                        if files.len() >= MAX_CODEX_SCAN { return files }
                    }
                }
            }
        }
    }
    files
}

/// The session id is the last 36 characters (a UUID) of `rollout-<time>-<uuid>.jsonl`.
fn codex_id(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    if stem.len() < 36 { return None }
    let id = &stem[stem.len() - 36..];
    is_session_id(id).then(|| id.to_string())
}

fn codex_first_user_text(head: &str, max: usize) -> Option<String> {
    head.lines().find_map(|line| {
        let value: Value = serde_json::from_str(line).ok()?;
        let payload = value.get("payload")?;
        if value.get("type").and_then(Value::as_str) != Some("response_item") || payload.get("type").and_then(Value::as_str) != Some("message") || payload.get("role").and_then(Value::as_str) != Some("user") { return None }
        payload.get("content")?.as_array()?.iter().find_map(|item| {
            let text = item.get("text").and_then(Value::as_str)?;
            (!is_codex_preamble(text)).then(|| clip(text, max))
        })
    })
}

fn list_codex(codex_home: &Path, workspace: &str) -> Vec<TranscriptSummary> {
    // Searched as text: the first record is large and a head window may cut it mid-way.
    let needle = format!("\"cwd\":{}", Value::String(workspace.to_string()));
    codex_rollouts(codex_home)
        .into_iter()
        .filter_map(|(path, modified)| {
            let (head, _) = read_window(&path, HEAD_READ, false).ok()?;
            if !head.contains(&needle) { return None }
            let first_prompt = codex_first_user_text(&head, PROMPT_CHARS)?;
            let title = clip(&first_prompt, TITLE_CHARS);
            Some(TranscriptSummary { id: codex_id(&path)?, provider: "codex".into(), title, first_prompt, modified_ms: modified, bytes: fs::metadata(&path).map(|m| m.len()).unwrap_or(0) })
        })
        .take(MAX_LIST)
        .collect()
}

fn codex_apply_patch_files(input: &str) -> Vec<String> {
    input
        .lines()
        .filter_map(|line| line.strip_prefix("*** Update File: ").or_else(|| line.strip_prefix("*** Add File: ")))
        .map(|path| path.trim().to_string())
        .collect()
}

/// Codex writes a running total with every `token_count` event, so the last one
/// is the session's size. Its input count includes cached input; split them so
/// the line reads the same as Claude's.
pub(crate) fn codex_usage(text: &str) -> Option<Usage> {
    let total = text.lines().rev().find_map(|line| {
        if !line.contains("total_token_usage") { return None }
        let value: Value = serde_json::from_str(line).ok()?;
        value.get("payload")?.get("info")?.get("total_token_usage").cloned()
    })?;
    let get = |key: &str| total.get(key).and_then(Value::as_u64).unwrap_or(0);
    let cached = get("cached_input_tokens");
    Some(Usage { input: get("input_tokens").saturating_sub(cached), output: get("output_tokens"), cache_read: cached, cache_create: get("cache_write_input_tokens") })
}

pub(crate) fn parse_codex(text: &str) -> Vec<Turn> {
    let mut turns: Vec<Turn> = Vec::new();
    let mut calls: HashMap<String, (usize, usize)> = HashMap::new();

    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else { continue };
        if value.get("type").and_then(Value::as_str) != Some("response_item") { continue }
        let Some(payload) = value.get("payload") else { continue };
        let at = value.get("timestamp").and_then(Value::as_str).map(str::to_string);
        match payload.get("type").and_then(Value::as_str) {
            Some("message") => {
                let role = payload.get("role").and_then(Value::as_str).unwrap_or_default();
                if role != "user" && role != "assistant" { continue }
                let texts: Vec<String> = payload
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|item| item.get("text").and_then(Value::as_str))
                    .filter(|text| !text.trim().is_empty() && !is_codex_preamble(text))
                    .map(|text| text.trim().to_string())
                    .collect();
                if texts.is_empty() { continue }
                if role == "assistant" && matches!(turns.last(), Some(turn) if turn.role == "assistant") {
                    let last = turns.len() - 1;
                    turns[last].blocks.extend(texts.into_iter().map(|text| Block::Text { text }));
                } else {
                    let mut turn = new_turn(role, at);
                    turn.blocks = texts.into_iter().map(|text| Block::Text { text }).collect();
                    turns.push(turn);
                }
            }
            Some(kind @ ("function_call" | "custom_tool_call")) => {
                if !matches!(turns.last(), Some(turn) if turn.role == "assistant") { turns.push(new_turn("assistant", at)) }
                let index = turns.len() - 1;
                let name = payload.get("name").and_then(Value::as_str).unwrap_or("tool").to_string();
                let (summary, files) = if kind == "function_call" {
                    let args: Value = payload.get("arguments").and_then(Value::as_str).and_then(|raw| serde_json::from_str(raw).ok()).unwrap_or(Value::Null);
                    (tool_summary(&args), Vec::new())
                } else {
                    let input = payload.get("input").and_then(Value::as_str).unwrap_or_default();
                    let files = codex_apply_patch_files(input);
                    (files.first().cloned().or_else(|| js_command(input).map(|cmd| clip(&cmd, 140))).unwrap_or_else(|| clip(input, 140)), files)
                };
                for file in files { push_file(&mut turns[index], file) }
                if let Some(id) = payload.get("call_id").and_then(Value::as_str) {
                    calls.insert(id.to_string(), (index, turns[index].blocks.len()));
                }
                turns[index].blocks.push(Block::Tool { name, summary, result: None });
            }
            Some("function_call_output" | "custom_tool_call_output") => {
                let id = payload.get("call_id").and_then(Value::as_str).unwrap_or_default();
                let Some(&(turn, index)) = calls.get(id) else { continue };
                let output = match payload.get("output") {
                    Some(Value::String(raw)) => serde_json::from_str::<Value>(raw).ok().and_then(|v| v.get("output").and_then(Value::as_str).map(str::to_string)).unwrap_or_else(|| raw.clone()),
                    other => result_text(other.unwrap_or(&Value::Null)),
                };
                if let Some(Block::Tool { result, .. }) = turns.get_mut(turn).and_then(|t| t.blocks.get_mut(index)) {
                    *result = Some(clip_keep_lines(&output, PREVIEW_CHARS));
                }
            }
            Some("reasoning") => {
                if !matches!(turns.last(), Some(turn) if turn.role == "assistant") { turns.push(new_turn("assistant", at)) }
                let last = turns.len() - 1;
                turns[last].thinking += 1;
            }
            _ => {}
        }
    }
    turns.retain(|turn| !turn.blocks.is_empty());
    turns
}

// ---------- entry points ----------

pub(crate) fn list(claude_home: &Path, codex_home: &Path, workspace: &str) -> Vec<TranscriptSummary> {
    let mut all = list_claude(claude_home, workspace);
    all.extend(list_codex(codex_home, workspace));
    all.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    all.truncate(MAX_LIST);
    all
}

pub(crate) fn read(claude_home: &Path, codex_home: &Path, workspace: &str, provider: &str, id: &str) -> Result<Transcript, String> {
    if !is_session_id(id) { return Err("Invalid session id".into()) }
    let path = match provider {
        "claude" => jsonl_files(&claude_dir(claude_home, workspace)).into_iter().map(|(path, _)| path).find(|path| path.file_stem().and_then(|s| s.to_str()) == Some(id)),
        "codex" => codex_rollouts(codex_home).into_iter().map(|(path, _)| path).find(|path| codex_id(path).as_deref() == Some(id)),
        _ => return Err("Unknown provider".into()),
    }
    .ok_or("That session file is gone")?;
    let (text, truncated) = read_window(&path, MAX_READ, true).map_err(|error| error.to_string())?;
    let (turns, usage) = if provider == "claude" { parse_claude(&text) } else { (parse_codex(&text), codex_usage(&text)) };
    Ok(Transcript { id: id.into(), provider: provider.into(), turns, truncated, usage })
}

pub(crate) fn homes() -> Result<(PathBuf, PathBuf), String> {
    let home = PathBuf::from(std::env::var("HOME").map_err(|error| format!("HOME not set: {error}"))?);
    let claude = std::env::var("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|_| home.join(".claude"));
    let codex = std::env::var("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|_| home.join(".codex"));
    Ok((claude, codex))
}

/// Past agent sessions for one workspace, newest first. Reads files only.
#[tauri::command]
pub async fn transcripts_list(workspace_path: String) -> Result<Vec<TranscriptSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (claude, codex) = homes()?;
        Ok(list(&claude, &codex, &workspace_path))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// One session's conversation, parsed from the newest part of its file.
#[tauri::command]
pub async fn transcript_read(workspace_path: String, provider: String, session_id: String) -> Result<Transcript, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (claude, codex) = homes()?;
        read(&claude, &codex, &workspace_path, &provider, &session_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);
    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bs-transcripts-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const CLAUDE_SESSION: &str = r#"{"type":"mode","mode":"x"}
{"type":"user","timestamp":"t1","message":{"role":"user","content":"<system-reminder>ignore me</system-reminder>Fix the header"}}
{"type":"assistant","timestamp":"t2","message":{"id":"m1","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100},"content":[{"type":"thinking","thinking":"hmm"}]}}
{"type":"assistant","timestamp":"t2","message":{"id":"m1","usage":{"input_tokens":10,"output_tokens":7,"cache_read_input_tokens":100},"content":[{"type":"text","text":"On it."},{"type":"tool_use","id":"tu1","name":"Edit","input":{"file_path":"src/App.tsx","old_string":"a","new_string":"b"}}]}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"updated"}]}}
{"type":"assistant","timestamp":"t3","isSidechain":true,"message":{"id":"m2","content":[{"type":"text","text":"sub-agent chatter"}]}}
{"type":"assistant","timestamp":"t4","message":{"id":"m3","usage":{"input_tokens":1,"output_tokens":2},"content":[{"type":"text","text":"Done."}]}}
{"type":"ai-title","aiTitle":"Header fix","sessionId":"s"}
"#;

    #[test]
    fn codex_usage_is_the_last_running_total() {
        let text = [
            r#"{"payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":5}}}}"#,
            r#"{"payload":{"type":"token_count","info":null}}"#,
            r#"{"payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":250,"output_tokens":20}}}}"#,
        ].join("\n");
        assert_eq!(codex_usage(&text), Some(Usage { input: 50, output: 20, cache_read: 250, cache_create: 0 }));
        assert_eq!(codex_usage("{}"), None);
    }

    #[test]
    fn lifts_the_command_out_of_a_codex_script() {
        let js = r#"const r = await tools.exec_command({cmd:"git status --short && echo \"hi\"", workdir:"/x"}); text(r)"#;
        assert_eq!(js_command(js).as_deref(), Some("git status --short && echo \"hi\""));
        assert_eq!(js_command("no command here"), None);
    }

    #[test]
    fn claude_turns_merge_tools_results_and_skip_sidechains() {
        let (turns, usage) = parse_claude(CLAUDE_SESSION);
        assert_eq!(turns.len(), 2, "user prompt + one merged assistant turn");
        assert_eq!(turns[0].blocks, vec![Block::Text { text: "Fix the header".into() }]);
        assert_eq!(turns[1].thinking, 1);
        assert_eq!(turns[1].files, vec!["src/App.tsx".to_string()]);
        assert_eq!(turns[1].blocks.len(), 3);
        assert_eq!(turns[1].blocks[1], Block::Tool { name: "Edit".into(), summary: "src/App.tsx".into(), result: Some("updated".into()) });
        // m1's repeated usage lines count once, with the larger output figure.
        assert_eq!(usage, Some(Usage { input: 11, output: 9, cache_read: 100, cache_create: 0 }));
    }

    #[test]
    fn lists_only_this_workspace_with_generated_title_and_reads_by_id() {
        let home = scratch();
        let workspace = "/home/dev/proj.v2";
        let dir = claude_dir(&home, workspace);
        assert_eq!(dir.file_name().unwrap(), "-home-dev-proj-v2");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("abc-123.jsonl"), CLAUDE_SESSION).unwrap();
        fs::write(dir.join("empty.jsonl"), "{\"type\":\"mode\"}\n").unwrap();
        let listed = list(&home, &home.join("none"), workspace);
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].id.as_str(), listed[0].title.as_str()), ("abc-123", "Header fix"));
        assert!(list(&home, &home.join("none"), "/home/dev/other").is_empty());
        let transcript = read(&home, &home.join("none"), workspace, "claude", "abc-123").unwrap();
        assert_eq!(transcript.turns.len(), 2);
        assert!(!transcript.truncated);
    }

    #[test]
    fn rejects_ids_that_could_escape_the_session_folder() {
        let home = scratch();
        for id in ["../secret", "a/b", "", "x.jsonl"] {
            assert!(read(&home, &home, "/w", "claude", id).is_err(), "{id}");
        }
        assert!(read(&home, &home, "/w", "other", "abc").is_err());
    }

    #[test]
    fn a_large_file_is_read_from_its_end_without_a_partial_first_line() {
        let home = scratch();
        let workspace = "/w";
        let dir = claude_dir(&home, workspace);
        fs::create_dir_all(&dir).unwrap();
        let line = |n: usize| format!("{{\"type\":\"user\",\"message\":{{\"content\":\"prompt {n} {}\"}}}}\n", "x".repeat(400));
        let body: String = (0..30_000).map(line).collect();
        assert!(body.len() as u64 > MAX_READ);
        fs::write(dir.join("big.jsonl"), body).unwrap();
        let transcript = read(&home, &home, workspace, "claude", "big").unwrap();
        assert!(transcript.truncated);
        let Block::Text { text } = transcript.turns.last().unwrap().blocks[0].clone() else { panic!() };
        assert!(text.starts_with("prompt 29999 "));
        assert!(transcript.turns.len() < 30_000 && !transcript.turns.is_empty());
    }

    fn codex_lines() -> String {
        [
            r##"{"type":"session_meta","payload":{"id":"x","cwd":"/home/dev/proj"}}"##,
            r##"{"type":"response_item","timestamp":"t0","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>cwd</environment_context>"}]}}"##,
            r##"{"type":"response_item","timestamp":"t1","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Add a dark mode toggle"}]}}"##,
            r##"{"type":"response_item","payload":{"type":"reasoning","summary":[]}}"##,
            r##"{"type":"response_item","payload":{"type":"function_call","name":"shell","call_id":"c1","arguments":"{\"command\":[\"bash\",\"-lc\",\"ls\"]}"}}"##,
            r##"{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"{\"output\":\"a.txt\"}"}}"##,
            r##"{"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","call_id":"c2","input":"*** Begin Patch\n*** Update File: src/theme.ts\n*** End Patch"}}"##,
            r##"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Added it."}]}}"##,
        ].join("\n")
    }

    #[test]
    fn codex_rollout_becomes_turns_with_tools_files_and_results() {
        let turns = parse_codex(&codex_lines());
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].blocks, vec![Block::Text { text: "Add a dark mode toggle".into() }]);
        assert_eq!(turns[1].thinking, 1);
        assert_eq!(turns[1].files, vec!["src/theme.ts".to_string()]);
        assert_eq!(turns[1].blocks[0], Block::Tool { name: "shell".into(), summary: "bash -lc ls".into(), result: Some("a.txt".into()) });
        assert_eq!(turns[1].blocks.last(), Some(&Block::Text { text: "Added it.".into() }));
    }

    #[test]
    fn codex_sessions_are_matched_to_the_workspace_by_cwd() {
        let home = scratch();
        let day = home.join("sessions/2026/11/07");
        fs::create_dir_all(&day).unwrap();
        let id = "01a1b271-613b-7851-afa7-13eba78181aa";
        fs::write(day.join(format!("rollout-2026-11-07T01-28-57-{id}.jsonl")), codex_lines()).unwrap();
        let listed = list(&home.join("none"), &home, "/home/dev/proj");
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].id.as_str(), listed[0].provider.as_str(), listed[0].title.as_str()), (id, "codex", "Add a dark mode toggle"));
        assert!(list(&home.join("none"), &home, "/home/dev/proj2").is_empty());
        assert_eq!(read(&home.join("none"), &home, "/x", "codex", id).unwrap().turns.len(), 2);
    }
}
