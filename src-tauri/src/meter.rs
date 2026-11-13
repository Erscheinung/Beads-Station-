// Designer Desk (Code-05b.3): a local-only usage meter, in the spirit of
// CodexBar but without cookies, keychain or network.
//
// - Codex writes its account-wide rate-limit windows (5 h and weekly, with the
//   reset time) into every `token_count` event of its rollout files. The newest
//   one is the best answer to "how much have I used".
// - Claude Code records per-message usage in its session files. Summed per
//   local day over the last week.
//
// Unknown stays unknown: no dollar figures, no guesses when a file has no usage,
// and `incomplete` says when a file was too large to read in full.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime};

use chrono::{DateTime, Local, NaiveDate};
use serde::Serialize;
use serde_json::Value;

use crate::transcripts::{codex_rollouts, homes, modified_ms, read_window};

const DAYS: i64 = 7;
const MAX_FILE_READ: u64 = 8 * 1024 * 1024;
const MAX_FILES: usize = 400;
const CODEX_TAIL: u64 = 2 * 1024 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LimitWindow {
    pub used_percent: f64,
    pub window_minutes: u64,
    /// Unix seconds.
    pub resets_at: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexLimits {
    pub plan: Option<String>,
    pub primary: Option<LimitWindow>,
    pub secondary: Option<LimitWindow>,
    /// When Codex last wrote this reading (RFC 3339). It is a snapshot, not live.
    pub observed_at: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
    pub day: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_create: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Meter {
    pub codex: Option<CodexLimits>,
    /// Oldest first, one entry per local day including empty days.
    pub claude_days: Vec<DayUsage>,
    /// True when a session file was larger than the read window, so totals may be low.
    pub incomplete: bool,
}

fn window(value: &Value) -> Option<LimitWindow> {
    Some(LimitWindow {
        used_percent: value.get("used_percent")?.as_f64()?,
        window_minutes: value.get("window_minutes")?.as_u64()?,
        resets_at: value.get("resets_at")?.as_u64()?,
    })
}

/// The last rate-limit reading in a block of rollout text.
pub(crate) fn last_codex_limits(text: &str) -> Option<CodexLimits> {
    text.lines().rev().filter(|line| line.contains("\"rate_limits\"")).find_map(|line| {
        let value: Value = serde_json::from_str(line).ok()?;
        let limits = value.get("payload")?.get("rate_limits")?;
        let primary = limits.get("primary").and_then(window);
        let secondary = limits.get("secondary").and_then(window);
        if primary.is_none() && secondary.is_none() { return None }
        Some(CodexLimits {
            plan: limits.get("plan_type").and_then(Value::as_str).map(str::to_string),
            primary,
            secondary,
            observed_at: value.get("timestamp").and_then(Value::as_str).map(str::to_string),
        })
    })
}

fn local_day(timestamp: &str) -> Option<NaiveDate> {
    DateTime::parse_from_rfc3339(timestamp).ok().map(|time| time.with_timezone(&Local).date_naive())
}

/// Add one Claude session file's assistant usage into `days`. Each message is
/// written as several lines that repeat its usage, so it is counted once, at
/// its largest figures.
pub(crate) fn add_claude_usage(text: &str, days: &mut BTreeMap<NaiveDate, DayUsage>) {
    struct Seen { day: NaiveDate, input: u64, output: u64, cache_read: u64, cache_create: u64 }
    let mut by_message: HashMap<String, Seen> = HashMap::new();
    for line in text.lines() {
        if !line.contains("\"usage\"") { continue }
        let Ok(value) = serde_json::from_str::<Value>(line) else { continue };
        if value.get("type").and_then(Value::as_str) != Some("assistant") || value.get("isSidechain").and_then(Value::as_bool) == Some(true) { continue }
        let Some(day) = value.get("timestamp").and_then(Value::as_str).and_then(local_day) else { continue };
        let Some(message) = value.get("message") else { continue };
        let Some(usage) = message.get("usage") else { continue };
        let id = message.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        let field = |name: &str| usage.get(name).and_then(Value::as_u64).unwrap_or(0);
        let entry = by_message.entry(id).or_insert(Seen { day, input: 0, output: 0, cache_read: 0, cache_create: 0 });
        entry.input = entry.input.max(field("input_tokens"));
        entry.output = entry.output.max(field("output_tokens"));
        entry.cache_read = entry.cache_read.max(field("cache_read_input_tokens"));
        entry.cache_create = entry.cache_create.max(field("cache_creation_input_tokens"));
    }
    for seen in by_message.values() {
        if let Some(total) = days.get_mut(&seen.day) {
            total.input += seen.input;
            total.output += seen.output;
            total.cache_read += seen.cache_read;
            total.cache_create += seen.cache_create;
        }
    }
}

pub(crate) fn build(claude_home: &Path, codex_home: &Path, today: NaiveDate) -> Meter {
    let mut days: BTreeMap<NaiveDate, DayUsage> = (0..DAYS)
        .map(|back| today - chrono::Days::new(back as u64))
        .map(|day| (day, DayUsage { day: day.to_string(), ..DayUsage::default() }))
        .collect();
    let oldest = SystemTime::now() - Duration::from_secs((DAYS as u64 + 1) * 86_400);
    let oldest_ms = oldest.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);

    let mut incomplete = false;
    let mut files: Vec<(std::path::PathBuf, u64)> = Vec::new();
    for project in fs::read_dir(claude_home.join("projects")).into_iter().flatten().flatten() {
        for entry in fs::read_dir(project.path()).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "jsonl") {
                let modified = modified_ms(&path);
                if modified >= oldest_ms { files.push((path, modified)) }
            }
        }
    }
    files.sort_by(|a, b| b.1.cmp(&a.1));
    if files.len() > MAX_FILES { files.truncate(MAX_FILES); incomplete = true }
    for (path, _) in &files {
        if let Ok((text, cut)) = read_window(path, MAX_FILE_READ, true) {
            incomplete |= cut;
            add_claude_usage(&text, &mut days);
        }
    }

    // Several sessions can run at once; the reading written last is the current one.
    let mut recent = codex_rollouts(codex_home);
    recent.sort_by(|a, b| b.1.cmp(&a.1));
    let codex = recent
        .into_iter()
        .take(6)
        .filter_map(|(path, _)| read_window(&path, CODEX_TAIL, true).ok().and_then(|(text, _)| last_codex_limits(&text)))
        .max_by(|a, b| a.observed_at.cmp(&b.observed_at));
    Meter { codex, claude_days: days.into_values().collect(), incomplete }
}

/// Local usage numbers from the agents' own files. Reads files only.
#[tauri::command]
pub async fn meter_summary() -> Result<Meter, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (claude, codex) = homes()?;
        Ok(build(&claude, &codex, Local::now().date_naive()))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_latest_codex_reading_and_ignores_records_without_windows() {
        let text = [
            r#"{"timestamp":"2026-11-07T10:00:00Z","payload":{"rate_limits":{"plan_type":"pro","primary":{"used_percent":10.0,"window_minutes":300,"resets_at":100},"secondary":{"used_percent":5.0,"window_minutes":10080,"resets_at":900}}}}"#,
            r#"{"timestamp":"2026-11-07T11:00:00Z","payload":{"rate_limits":{"plan_type":"pro","primary":{"used_percent":42.0,"window_minutes":300,"resets_at":200},"secondary":{"used_percent":22.0,"window_minutes":10080,"resets_at":950}}}}"#,
            r#"{"timestamp":"2026-11-07T12:00:00Z","payload":{"rate_limits":{"primary":null}}}"#,
        ].join("\n");
        let limits = last_codex_limits(&text).unwrap();
        assert_eq!(limits.primary, Some(LimitWindow { used_percent: 42.0, window_minutes: 300, resets_at: 200 }));
        assert_eq!(limits.secondary.unwrap().used_percent, 22.0);
        assert_eq!(limits.plan.as_deref(), Some("pro"));
        assert_eq!(limits.observed_at.as_deref(), Some("2026-11-07T11:00:00Z"));
        assert!(last_codex_limits("{}\nnot json").is_none());
    }

    #[test]
    fn sums_claude_usage_per_local_day_counting_each_message_once() {
        let today = Local::now().date_naive();
        let noon = today.and_hms_opt(12, 0, 0).unwrap().and_local_timezone(Local).unwrap().to_rfc3339();
        let line = |id: &str, out: u64, extra: &str| format!(r#"{{"type":"assistant","timestamp":"{noon}"{extra},"message":{{"id":"{id}","usage":{{"input_tokens":10,"output_tokens":{out},"cache_read_input_tokens":100}}}}}}"#);
        let text = [line("m1", 5, ""), line("m1", 9, ""), line("m2", 1, ""), line("side", 999, r#","isSidechain":true"#)].join("\n");
        let mut days: BTreeMap<NaiveDate, DayUsage> = BTreeMap::new();
        days.insert(today, DayUsage { day: today.to_string(), ..DayUsage::default() });
        add_claude_usage(&text, &mut days);
        let total = &days[&today];
        assert_eq!((total.input, total.output, total.cache_read), (20, 10, 200));
    }

    #[test]
    fn build_reads_both_homes_and_fills_empty_days() {
        let root = std::env::temp_dir().join(format!("bs-meter-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let project = root.join("claude/projects/-home-dev-app");
        fs::create_dir_all(&project).unwrap();
        let today = Local::now().date_naive();
        let stamp = today.and_hms_opt(9, 0, 0).unwrap().and_local_timezone(Local).unwrap().to_rfc3339();
        fs::write(project.join("s.jsonl"), format!(r#"{{"type":"assistant","timestamp":"{stamp}","message":{{"id":"a","usage":{{"input_tokens":3,"output_tokens":4}}}}}}"#)).unwrap();
        let day = root.join("codex/sessions/2026/11/07");
        fs::create_dir_all(&day).unwrap();
        fs::write(day.join("rollout-2026-11-07T01-00-00-01a1b271-613b-7851-afa7-13eba78181aa.jsonl"),
            r#"{"timestamp":"t","payload":{"rate_limits":{"primary":{"used_percent":7.0,"window_minutes":300,"resets_at":5}}}}"#).unwrap();
        let meter = build(&root.join("claude"), &root.join("codex"), today);
        assert_eq!(meter.claude_days.len(), 7);
        assert_eq!(meter.claude_days.last().unwrap().output, 4);
        assert_eq!(meter.claude_days.first().unwrap().output, 0);
        assert_eq!(meter.codex.unwrap().primary.unwrap().used_percent, 7.0);
        assert!(!meter.incomplete);
        let _ = fs::remove_dir_all(&root);
    }
}
