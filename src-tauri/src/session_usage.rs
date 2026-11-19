// Live session usage for one terminal pane (Code-7xc.1): how big the agent
// session running there is, how full its context is and, for Codex, the
// account's rate-limit windows. Read from the CLIs' own session files only;
// nothing here starts a model turn or touches the network.
//
// The page names a session by provider + id (and, for Gemini, the folder the
// CLI runs in); a path never comes from the page. Terminal output can be
// forged by any program, so an id is matched against file names we list.
// Unknown stays unknown: a field the file does not have is None, never 0.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::meter::{last_codex_limits, CodexLimits};
use crate::transcripts::{codex_id, codex_rollouts, homes, is_session_id, jsonl_files, modified_ms, read_window, Usage};

/// The newest part of a session file read for its totals.
const MAX_READ: u64 = 8 * 1024 * 1024;
/// Codex writes a full running total with every token count, so the tail is enough.
const CODEX_TAIL: u64 = 2 * 1024 * 1024;
const MAX_SUBAGENTS: usize = 40;
/// Two Gemini sessions written this close together cannot be told apart by time.
const GEMINI_AMBIGUOUS_MS: u64 = 10 * 60 * 1000;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub provider: String,
    /// The session these numbers belong to (for Gemini, the one that was found).
    pub session_id: Option<String>,
    /// The main session's tokens so far.
    pub usage: Option<Usage>,
    /// Claude subagent transcripts beside the session.
    pub subagents: u32,
    pub subagent_usage: Option<Usage>,
    /// Tokens in the context at the newest turn.
    pub context_tokens: Option<u64>,
    /// The model's context window, when the file says.
    pub context_window: Option<u64>,
    /// Codex's account-wide windows from this session's newest reading.
    pub limits: Option<CodexLimits>,
    /// True when a file was larger than the read window, so totals may be low.
    pub truncated: bool,
}

fn add(sum: &mut Usage, more: &Usage) {
    sum.input += more.input;
    sum.output += more.output;
    sum.cache_read += more.cache_read;
    sum.cache_create += more.cache_create;
}

// ---------- Claude ----------

/// Totals and the newest context size from a Claude session file. Each
/// message is written as several lines repeating its usage; counted once at
/// its largest figures, like the transcript reader does.
pub(crate) fn claude_totals(text: &str, keep_sidechain: bool) -> (Option<Usage>, Option<u64>) {
    let mut by_message: Vec<(String, Usage)> = Vec::new();
    let mut context = None;
    for line in text.lines() {
        if !line.contains("\"usage\"") { continue }
        let Ok(value) = serde_json::from_str::<Value>(line) else { continue };
        if value.get("type").and_then(Value::as_str) != Some("assistant") { continue }
        if !keep_sidechain && value.get("isSidechain").and_then(Value::as_bool) == Some(true) { continue }
        let Some(message) = value.get("message") else { continue };
        let Some(usage) = message.get("usage") else { continue };
        let field = |name: &str| usage.get(name).and_then(Value::as_u64).unwrap_or(0);
        let id = message.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        let index = match by_message.iter().position(|(seen, _)| !id.is_empty() && *seen == id) {
            Some(index) => index,
            None => { by_message.push((id, Usage::default())); by_message.len() - 1 }
        };
        let entry = &mut by_message[index].1;
        entry.input = entry.input.max(field("input_tokens"));
        entry.output = entry.output.max(field("output_tokens"));
        entry.cache_read = entry.cache_read.max(field("cache_read_input_tokens"));
        entry.cache_create = entry.cache_create.max(field("cache_creation_input_tokens"));
        // What the model saw on this turn: the whole prompt, cached or not.
        context = Some(field("input_tokens") + field("cache_read_input_tokens") + field("cache_creation_input_tokens"));
    }
    if by_message.is_empty() { return (None, None) }
    let mut total = Usage::default();
    for (_, usage) in &by_message { add(&mut total, usage) }
    (Some(total), context)
}

/// `projects/<any>/<id>.jsonl`: found by id, so a `cd` after starting does not matter.
pub(crate) fn find_claude_session(claude_home: &Path, id: &str) -> Option<PathBuf> {
    if !is_session_id(id) { return None }
    let name = format!("{id}.jsonl");
    fs::read_dir(claude_home.join("projects")).ok()?.flatten().map(|entry| entry.path().join(&name)).find(|path| path.is_file())
}

type Totals = (Option<Usage>, Option<u64>, bool);

/// Totals of a file, reused while its size and time are unchanged: a pane asks
/// every few seconds and a long session file is megabytes.
fn cached_claude_totals(path: &Path, keep_sidechain: bool) -> Option<Totals> {
    static CACHE: std::sync::Mutex<Vec<(PathBuf, u64, u64, Totals)>> = std::sync::Mutex::new(Vec::new());
    let len = fs::metadata(path).ok()?.len();
    let modified = modified_ms(path);
    let mut cache = CACHE.lock().unwrap_or_else(|error| error.into_inner());
    if let Some((_, _, _, totals)) = cache.iter().find(|(seen, l, m, _)| seen == path && *l == len && *m == modified) {
        return Some(totals.clone());
    }
    let (text, truncated) = read_window(path, MAX_READ, true).ok()?;
    let (usage, context) = claude_totals(&text, keep_sidechain);
    let totals = (usage, context, truncated);
    cache.retain(|(seen, ..)| seen != path);
    if cache.len() >= 128 { cache.remove(0); }
    cache.push((path.to_path_buf(), len, modified, totals.clone()));
    Some(totals)
}

pub(crate) fn claude_usage(claude_home: &Path, id: &str) -> Option<SessionUsage> {
    let path = find_claude_session(claude_home, id)?;
    let (usage, context_tokens, truncated) = cached_claude_totals(&path, false)?;
    let mut result = SessionUsage { provider: "claude".into(), session_id: Some(id.into()), usage, context_tokens, truncated, ..SessionUsage::default() };
    // Subagents: `<id>/subagents/agent-*.jsonl` beside the session (as the Designer's Agents view reads them).
    let subagents_dir = path.with_extension("").join("subagents");
    let mut subagent_usage: Option<Usage> = None;
    for (file, _) in jsonl_files(&subagents_dir).into_iter().take(MAX_SUBAGENTS) {
        result.subagents += 1;
        let Some((usage, _, cut)) = cached_claude_totals(&file, true) else { continue };
        result.truncated |= cut;
        if let Some(usage) = usage {
            add(subagent_usage.get_or_insert_with(Usage::default), &usage);
        }
    }
    result.subagent_usage = subagent_usage;
    Some(result)
}

// ---------- Codex ----------

/// Codex's newest `token_count` event: running total, the last turn and the window.
pub(crate) fn codex_reading(text: &str) -> (Option<Usage>, Option<u64>, Option<u64>) {
    let info = text.lines().rev().find_map(|line| {
        if !line.contains("\"token_count\"") || !line.contains("total_token_usage") { return None }
        let value: Value = serde_json::from_str(line).ok()?;
        value.get("payload")?.get("info").filter(|info| info.is_object()).cloned()
    });
    let Some(info) = info else { return (None, None, None) };
    let usage = info.get("total_token_usage").map(codex_split);
    let context = info.get("last_token_usage").and_then(|last| {
        last.get("total_tokens").and_then(Value::as_u64).or_else(|| {
            let input = last.get("input_tokens").and_then(Value::as_u64)?;
            Some(input + last.get("output_tokens").and_then(Value::as_u64).unwrap_or(0))
        })
    });
    let window = info.get("model_context_window").and_then(Value::as_u64);
    (usage, context, window)
}

/// Codex counts cached input inside input; split them so the line reads the same as Claude's.
fn codex_split(total: &Value) -> Usage {
    let get = |key: &str| total.get(key).and_then(Value::as_u64).unwrap_or(0);
    let cached = get("cached_input_tokens");
    Usage { input: get("input_tokens").saturating_sub(cached), output: get("output_tokens"), cache_read: cached, cache_create: 0 }
}

pub(crate) fn codex_usage(codex_home: &Path, id: &str) -> Option<SessionUsage> {
    if !is_session_id(id) { return None }
    let path = codex_rollouts(codex_home).into_iter().map(|(path, _)| path).find(|path| codex_id(path).as_deref() == Some(id))?;
    let (text, truncated) = read_window(&path, CODEX_TAIL, true).ok()?;
    let (usage, context_tokens, context_window) = codex_reading(&text);
    // The running total is in the tail, so a cut file is still exact when it has one.
    let truncated = truncated && usage.is_none();
    Some(SessionUsage {
        provider: "codex".into(),
        session_id: Some(id.into()),
        usage,
        context_tokens,
        context_window,
        limits: last_codex_limits(&text),
        truncated,
        ..SessionUsage::default()
    })
}

// ---------- Gemini ----------
//
// Gemini CLI saves each chat as `~/.gemini/tmp/<sha256 of the project folder>/chats/session-<time>-<id>.json`:
// `{ sessionId, messages: [{ type: "gemini", tokens: { input, output, cached, thoughts, tool, total } }] }`.
// Written against that format without a real file on this machine: every field is optional.

pub(crate) fn gemini_totals(text: &str) -> Option<SessionUsage> {
    let value: Value = serde_json::from_str(text).ok()?;
    let mut usage: Option<Usage> = None;
    let mut context = None;
    for message in value.get("messages")?.as_array()? {
        let Some(tokens) = message.get("tokens").filter(|tokens| tokens.is_object()) else { continue };
        let get = |key: &str| tokens.get(key).and_then(Value::as_u64);
        let (Some(input), output) = (get("input"), get("output")) else { continue };
        let cached = get("cached").unwrap_or(0);
        let sum = usage.get_or_insert_with(Usage::default);
        sum.input += input.saturating_sub(cached);
        sum.cache_read += cached;
        sum.output += output.unwrap_or(0) + get("thoughts").unwrap_or(0);
        context = Some(input + output.unwrap_or(0));
    }
    Some(SessionUsage {
        provider: "gemini".into(),
        session_id: value.get("sessionId").and_then(Value::as_str).filter(|id| is_session_id(id)).map(str::to_string),
        usage,
        context_tokens: context,
        ..SessionUsage::default()
    })
}

/// The chat for this folder: the one with this id, or, with no id, the newest
/// when no other was written around the same time (otherwise unknown).
pub(crate) fn gemini_usage(gemini_home: &Path, cwd: &str, id: Option<&str>) -> Option<SessionUsage> {
    let chats = gemini_home.join("tmp").join(sha256_hex(cwd.as_bytes())).join("chats");
    let mut files: Vec<(PathBuf, u64)> = fs::read_dir(&chats)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json") && path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("session-")))
        .map(|path| { let modified = modified_ms(&path); (path, modified) })
        .collect();
    files.sort_by(|a, b| b.1.cmp(&a.1));
    let read = |path: &Path| -> Option<SessionUsage> {
        if fs::metadata(path).ok()?.len() > 32 * 1024 * 1024 { return None }
        gemini_totals(&fs::read_to_string(path).ok()?)
    };
    match id.filter(|id| is_session_id(id)) {
        Some(id) => {
            // The file name carries the id's first eight characters; confirm inside.
            let short = id.get(..8).unwrap_or(id);
            files.iter().filter(|(path, _)| path.to_string_lossy().contains(short)).find_map(|(path, _)| read(path).filter(|usage| usage.session_id.as_deref() == Some(id)))
        }
        None => {
            let (newest, newest_ms) = files.first()?;
            if files.get(1).is_some_and(|(_, other)| newest_ms.saturating_sub(*other) < GEMINI_AMBIGUOUS_MS) { return None }
            read(newest)
        }
    }
}

/// SHA-256, hex. Gemini names a project's folder with it; small enough not to need a crate.
pub(crate) fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut h: [u32; 8] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    let mut message = data.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 { message.push(0) }
    message.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for chunk in message.chunks(64) {
        let mut w = [0u32; 64];
        for (i, word) in chunk.chunks(4).enumerate() { w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]) }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g; g = f; f = e; e = d.wrapping_add(t1); d = c; c = b; b = a; a = t1.wrapping_add(t2);
        }
        for (slot, value) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) { *slot = slot.wrapping_add(value) }
    }
    h.iter().map(|word| format!("{word:08x}")).collect()
}

fn gemini_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".gemini"))
}

/// Usage of the agent session in one pane. Reads files only; None fields are unknown.
#[tauri::command]
pub async fn session_usage(provider: String, session_id: Option<String>, cwd: Option<String>) -> Result<Option<SessionUsage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (claude, codex) = homes()?;
        Ok(match provider.as_str() {
            "claude" => session_id.as_deref().and_then(|id| claude_usage(&claude, id)),
            "codex" => session_id.as_deref().and_then(|id| codex_usage(&codex, id)),
            "gemini" => match (gemini_home(), cwd.as_deref()) {
                (Some(home), Some(cwd)) if cwd.starts_with('/') => gemini_usage(&home, cwd, session_id.as_deref()),
                _ => None,
            },
            _ => return Err("Unknown provider".to_string()),
        })
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
        let dir = std::env::temp_dir().join(format!("bs-session-usage-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const ID: &str = "2c975569-13c1-43b2-8e7a-f88d6138d7d8";

    #[test]
    fn sha256_matches_known_vectors() {
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(sha256_hex(&[b'a'; 1000]), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
    }

    #[test]
    fn claude_session_is_found_by_id_in_any_project_and_sums_its_subagents() {
        let home = scratch();
        // The pane started in one folder and cd'd: the project folder name does not matter.
        let project = home.join("projects/-somewhere-else");
        fs::create_dir_all(project.join(ID).join("subagents")).unwrap();
        fs::write(project.join(format!("{ID}.jsonl")), [
            r#"{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":1000}}}"#,
            r#"{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":10,"output_tokens":9,"cache_read_input_tokens":1000}}}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"id":"side","usage":{"input_tokens":500,"output_tokens":500}}}"#,
            r#"{"type":"assistant","message":{"id":"m2","usage":{"input_tokens":3,"output_tokens":4,"cache_read_input_tokens":2000,"cache_creation_input_tokens":100}}}"#,
        ].join("\n")).unwrap();
        fs::write(project.join(ID).join("subagents/agent-a1.jsonl"), r#"{"type":"assistant","isSidechain":true,"message":{"id":"s1","usage":{"input_tokens":7,"output_tokens":70}}}"#).unwrap();
        fs::write(project.join(ID).join("subagents/agent-b2.jsonl"), r#"{"type":"assistant","isSidechain":true,"message":{"id":"s2","usage":{"input_tokens":1,"output_tokens":30,"cache_read_input_tokens":5}}}"#).unwrap();
        fs::write(project.join(ID).join("subagents/agent-b2.meta.json"), "{}").unwrap();

        let usage = claude_usage(&home, ID).unwrap();
        assert_eq!(usage.usage, Some(Usage { input: 13, output: 13, cache_read: 3000, cache_create: 100 }));
        assert_eq!(usage.context_tokens, Some(2103));
        assert_eq!(usage.context_window, None);
        assert_eq!(usage.subagents, 2);
        assert_eq!(usage.subagent_usage, Some(Usage { input: 8, output: 100, cache_read: 5, cache_create: 0 }));
        assert!(claude_usage(&home, "../../etc/passwd").is_none());
        assert!(claude_usage(&home, "0123abcd-0123-4abc-8def-0123456789ab").is_none());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn a_claude_session_without_usage_is_unknown_not_zero() {
        assert_eq!(claude_totals(r#"{"type":"user","message":{"content":"hi"}}"#, false), (None, None));
    }

    const CODEX_ROLLOUT: &str = r#"{"timestamp":"2026-11-20T09:00:00Z","type":"session_meta","payload":{"id":"x"}}
{"timestamp":"2026-11-20T09:01:00Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"primary":{"used_percent":10.0,"window_minutes":300,"resets_at":1763650800}}}}
{"timestamp":"2026-11-20T09:02:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":120000,"cached_input_tokens":100000,"output_tokens":3000,"reasoning_output_tokens":1000,"total_tokens":123000},"last_token_usage":{"input_tokens":95000,"cached_input_tokens":90000,"output_tokens":1000,"total_tokens":96000},"model_context_window":475000},"rate_limits":{"primary":{"used_percent":81.0,"window_minutes":300,"resets_at":1763650800},"secondary":{"used_percent":69.0,"window_minutes":10080,"resets_at":1764000000},"plan_type":"pro"}}}"#;

    #[test]
    fn codex_rollout_gives_totals_context_and_limits() {
        let (usage, context, window) = codex_reading(CODEX_ROLLOUT);
        assert_eq!(usage, Some(Usage { input: 20000, output: 3000, cache_read: 100000, cache_create: 0 }));
        assert_eq!(context, Some(96000));
        assert_eq!(window, Some(475000));
        assert_eq!(codex_reading("{}"), (None, None, None));

        let home = scratch();
        let day = home.join("sessions/2026/11/20");
        fs::create_dir_all(&day).unwrap();
        let id = "01a12f2b-69d8-7ea0-a23b-0fd1d81cac0e";
        fs::write(day.join(format!("rollout-2026-11-20T09-00-00-{id}.jsonl")), CODEX_ROLLOUT).unwrap();
        let found = codex_usage(&home, id).unwrap();
        assert_eq!(found.context_window, Some(475000));
        let limits = found.limits.unwrap();
        assert_eq!(limits.primary.unwrap().used_percent, 81.0);
        assert_eq!(limits.secondary.unwrap().window_minutes, 10080);
        assert!(codex_usage(&home, "01a12f2b-69d8-7ea0-a23b-000000000000").is_none());
        let _ = fs::remove_dir_all(&home);
    }

    const GEMINI_CHAT: &str = r#"{"sessionId":"7f3e1b52-9c1d-4e2a-8b6f-0a1b2c3d4e5f","projectHash":"x","startTime":"2026-11-20T09:00:00Z","messages":[
{"id":"1","type":"user","content":"hi"},
{"id":"2","type":"gemini","content":"hello","tokens":{"input":1200,"output":40,"cached":1000,"thoughts":60,"tool":0,"total":1300},"model":"gemini-2.5-pro"},
{"id":"3","type":"gemini","content":"no tokens here"},
{"id":"4","type":"gemini","content":"more","tokens":{"input":2400,"output":10}}
]}"#;

    #[test]
    fn gemini_chat_is_parsed_with_every_field_optional() {
        let usage = gemini_totals(GEMINI_CHAT).unwrap();
        assert_eq!(usage.session_id.as_deref(), Some("7f3e1b52-9c1d-4e2a-8b6f-0a1b2c3d4e5f"));
        assert_eq!(usage.usage, Some(Usage { input: 200 + 2400, output: 100 + 10, cache_read: 1000, cache_create: 0 }));
        assert_eq!(usage.context_tokens, Some(2410));
        assert_eq!(usage.context_window, None);
        let empty = gemini_totals(r#"{"messages":[{"type":"user"}]}"#).unwrap();
        assert_eq!((empty.usage, empty.context_tokens, empty.session_id), (None, None, None));
        assert!(gemini_totals("not json").is_none());
    }

    #[test]
    fn gemini_session_is_found_by_folder_hash_and_ambiguity_is_unknown() {
        let home = scratch();
        let cwd = "/work/sample-project";
        let chats = home.join("tmp").join(sha256_hex(cwd.as_bytes())).join("chats");
        fs::create_dir_all(&chats).unwrap();
        fs::write(chats.join("session-2026-11-20T09-00-7f3e1b52.json"), GEMINI_CHAT).unwrap();
        assert_eq!(gemini_usage(&home, cwd, None).unwrap().session_id.as_deref(), Some("7f3e1b52-9c1d-4e2a-8b6f-0a1b2c3d4e5f"));
        assert!(gemini_usage(&home, "/work/other", None).is_none());
        // A second chat written at the same time: which one is this pane's is unknown.
        fs::write(chats.join("session-2026-11-20T09-01-11111111.json"), GEMINI_CHAT.replace("7f3e1b52-9c1d", "11111111-9c1d")).unwrap();
        assert!(gemini_usage(&home, cwd, None).is_none());
        // With the id, it is exact.
        let exact = gemini_usage(&home, cwd, Some("11111111-9c1d-4e2a-8b6f-0a1b2c3d4e5f")).unwrap();
        assert_eq!(exact.session_id.as_deref(), Some("11111111-9c1d-4e2a-8b6f-0a1b2c3d4e5f"));
        let _ = fs::remove_dir_all(&home);
    }
}
