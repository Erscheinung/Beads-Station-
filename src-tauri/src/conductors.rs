// Code-da0.5 — pluggable Designer conductor backends.
//
// A Designer ticket run can go straight to a provider CLI (`claude`, `codex`)
// or through a conductor that plans and delegates the work:
//
//   codex-orchestrator  The Codex adaptive orchestrator profile
//                       (github.com/Erscheinung/codex-astra-luna-orchestrator):
//                       a primary Sol agent owns scope and delegates bounded
//                       implementation to Luna workers. It runs as an ordinary
//                       `codex exec` child, so it inherits the native run's
//                       ownership, cancellation, artifact capture and approval.
//                       Available when `codex` is installed and the
//                       adaptive-orchestrator skill is present in the workspace
//                       (`.agents/skills/…`) or globally (`~/.codex/skills/…`).
//
//   opus-conductor      The Claude Code adaptive orchestrator
//                       (github.com/Erscheinung/opus-sonnet-conductor): the
//                       primary Opus session plans and delegates reads to a
//                       Haiku reader and bounded implementation to Sonnet
//                       workers. It runs as an ordinary `claude --print`
//                       child. Available when `claude` is installed and both
//                       the adaptive-orchestrator skill and the sonnet-worker
//                       agent are present in the workspace (`.claude/…`) or
//                       globally (`~/.claude/…`); its `setup.sh` installs both.
//
// Detection is filesystem-only: no subprocess, no model call, no credential
// read. Launching happens only on an explicit Start in the Designer.

use std::path::{Path, PathBuf};

pub const CODEX_ORCHESTRATOR: &str = "codex-orchestrator";
pub const OPUS_CONDUCTOR: &str = "opus-conductor";

const ORCHESTRATOR_SKILL: &str = "skills/adaptive-orchestrator/SKILL.md";
pub const ORCHESTRATOR_SOURCE: &str = "https://github.com/Erscheinung/codex-astra-luna-orchestrator";

/// Locate the adaptive-orchestrator skill for `cwd`: the workspace-installed
/// profile wins over the global one, mirroring how Codex resolves skills.
pub fn orchestrator_skill(cwd: Option<&Path>, home: Option<&Path>, codex_home: Option<&Path>) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(cwd) = cwd {
        candidates.push(cwd.join(".agents").join(ORCHESTRATOR_SKILL));
    }
    if let Some(codex_home) = codex_home {
        candidates.push(codex_home.join(ORCHESTRATOR_SKILL));
    }
    if let Some(home) = home {
        candidates.push(home.join(".codex").join(ORCHESTRATOR_SKILL));
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).filter(|v| !v.is_empty()).map(PathBuf::from)
}

pub fn current_orchestrator_skill(cwd: Option<&Path>) -> Option<PathBuf> {
    orchestrator_skill(cwd, env_path("HOME").as_deref(), env_path("CODEX_HOME").as_deref())
}

pub const OPUS_CONDUCTOR_SOURCE: &str = "https://github.com/Erscheinung/opus-sonnet-conductor";
const OPUS_WORKER_AGENT: &str = "agents/sonnet-worker.md";

/// Locate the Claude-side orchestrator for `cwd`. A `.claude` directory is
/// usable only when it has both the skill and the worker agent it delegates
/// to: the skill alone would leave every subagent on the parent's model.
pub fn opus_conductor_skill(cwd: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
    [cwd, home]
        .into_iter()
        .flatten()
        .map(|base| base.join(".claude"))
        .find(|claude| claude.join(ORCHESTRATOR_SKILL).is_file() && claude.join(OPUS_WORKER_AGENT).is_file())
        .map(|claude| claude.join(ORCHESTRATOR_SKILL))
}

pub fn current_opus_conductor_skill(cwd: Option<&Path>) -> Option<PathBuf> {
    opus_conductor_skill(cwd, env_path("HOME").as_deref())
}

/// A local checkout of the conductor, when the user has pointed at one. It is
/// only used to say where its installer is.
pub fn opus_conductor_dir() -> Option<PathBuf> {
    env_path("BS_OPUS_CONDUCTOR_DIR").filter(|dir| dir.join("setup.sh").is_file())
}

pub fn opus_missing_detail(dir: Option<&Path>) -> String {
    match dir {
        Some(dir) => format!(
            "Not installed for this workspace: run {}/setup.sh (or setup.sh --global)",
            dir.display()
        ),
        None => format!("Install the adaptive-orchestrator skill and agents from {OPUS_CONDUCTOR_SOURCE}"),
    }
}

/// Wrap a ticket prompt so the primary Claude session routes through the
/// adaptive orchestrator instead of doing everything in one Opus context.
pub fn opus_conductor_prompt(ticket_prompt: &str) -> String {
    format!(
        "Use the adaptive-orchestrator skill for this ticket.\n\
         You are the primary session: own scope, decisions, delegation and the final report.\n\
         Read with the haiku-reader agent. Delegate bounded implementation to sonnet-worker \
         (or sonnet-worker-lite for low-risk mechanical edits) with a self-contained brief and \
         testable acceptance criteria. Name subagent_type and model on every Agent call; never \
         spawn a general-purpose agent or a reviewer. Do small edits inline.\n\
         Finish with: changed files, checks actually run and their results, and remaining limitations.\n\n\
         --- Ticket ---\n{ticket_prompt}"
    )
}

/// Wrap a ticket prompt so the primary Codex agent routes through the
/// adaptive orchestrator instead of implementing everything itself.
pub fn orchestrator_prompt(ticket_prompt: &str) -> String {
    format!(
        "Use the adaptive-orchestrator skill for this ticket.\n\
         You are the primary agent: own scope, decisions, delegation and the final report.\n\
         Delegate routine implementation to one bounded worker with fork_turns=\"none\" and a \
         self-contained brief (outcome, files owned, constraints, acceptance criteria, focused checks). \
         Add a second worker only for independent, non-overlapping work. Do not spawn a reviewer.\n\
         Finish with: changed files, checks actually run and their results, and remaining limitations.\n\n\
         --- Ticket ---\n{ticket_prompt}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bs-conductors-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn install_skill(root: &Path) -> PathBuf {
        let skill = root.join(ORCHESTRATOR_SKILL);
        std::fs::create_dir_all(skill.parent().unwrap()).unwrap();
        std::fs::write(&skill, "# skill").unwrap();
        skill
    }

    #[test]
    fn workspace_skill_wins_over_global() {
        let workspace = temp_dir("ws");
        let home = temp_dir("home");
        let global = install_skill(&home.join(".codex"));
        assert_eq!(orchestrator_skill(Some(&workspace), Some(&home), None), Some(global));
        let local = install_skill(&workspace.join(".agents"));
        assert_eq!(orchestrator_skill(Some(&workspace), Some(&home), None), Some(local));
    }

    #[test]
    fn missing_skill_is_unavailable() {
        let empty = temp_dir("empty");
        assert_eq!(orchestrator_skill(Some(&empty), Some(&empty), Some(&empty)), None);
    }

    #[test]
    fn prompt_keeps_ticket_and_forbids_reviewer() {
        let wrapped = orchestrator_prompt("Work on ticket Code-1");
        assert!(wrapped.contains("adaptive-orchestrator"));
        assert!(wrapped.contains("Do not spawn a reviewer"));
        assert!(wrapped.ends_with("Work on ticket Code-1"));
    }

    fn install_opus(root: &Path, with_agent: bool) -> PathBuf {
        let skill = install_skill(&root.join(".claude"));
        if with_agent {
            let agent = root.join(".claude").join(OPUS_WORKER_AGENT);
            std::fs::create_dir_all(agent.parent().unwrap()).unwrap();
            std::fs::write(agent, "---\nmodel: sonnet\n---").unwrap();
        }
        skill
    }

    #[test]
    fn opus_conductor_needs_the_skill_and_its_worker_agent() {
        let workspace = temp_dir("opus-ws");
        let home = temp_dir("opus-home");
        assert_eq!(opus_conductor_skill(Some(&workspace), Some(&home)), None);
        install_opus(&workspace, false);
        assert_eq!(opus_conductor_skill(Some(&workspace), Some(&home)), None);
        let global = install_opus(&home, true);
        assert_eq!(opus_conductor_skill(Some(&workspace), Some(&home)), Some(global));
        let local = install_opus(&workspace, true);
        assert_eq!(opus_conductor_skill(Some(&workspace), Some(&home)), Some(local));
    }

    #[test]
    fn opus_prompt_keeps_the_ticket_and_names_the_tiers() {
        let wrapped = opus_conductor_prompt("Work on ticket Code-1");
        assert!(wrapped.contains("adaptive-orchestrator"));
        assert!(wrapped.contains("sonnet-worker"));
        assert!(wrapped.contains("haiku-reader"));
        assert!(wrapped.ends_with("Work on ticket Code-1"));
        assert!(opus_missing_detail(None).contains("opus-sonnet-conductor"));
        assert!(opus_missing_detail(Some(Path::new("/x"))).contains("/x/setup.sh"));
    }
}

// ── Worker visibility (Code-am5.8) ──────────────────────────────────────────
// `codex exec --json` reports only the primary thread. A delegated worker
// writes its own rollout file, named after its thread id; this reads the tail
// of that file and reduces it to a few readable lines.

const WORKER_TAIL_BYTES: u64 = 256 * 1024;
const WORKER_LINES: usize = 40;
const WORKER_LINE_CHARS: usize = 400;

fn is_thread_id(value: &str) -> bool {
    (8..=64).contains(&value.len())
        && value.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

fn clip(text: &str) -> String {
    let text = text.trim();
    if text.chars().count() <= WORKER_LINE_CHARS {
        return text.to_string();
    }
    let mut clipped: String = text.chars().take(WORKER_LINE_CHARS).collect();
    clipped.push('…');
    clipped
}

/// One readable line for a rollout record, or None for bookkeeping records.
fn worker_line(record: &serde_json::Value) -> Option<String> {
    let payload = record.get("payload")?;
    let kind = payload.get("type").and_then(|value| value.as_str())?;
    match (record.get("type").and_then(|value| value.as_str())?, kind) {
        ("response_item", "message") => {
            if payload.get("role").and_then(|value| value.as_str()) != Some("assistant") {
                return None;
            }
            let text: Vec<&str> = payload
                .get("content")?
                .as_array()?
                .iter()
                .filter_map(|block| block.get("text").and_then(|value| value.as_str()))
                .collect();
            let text = text.join("\n");
            (!text.trim().is_empty()).then(|| clip(&text))
        }
        ("response_item", "function_call") | ("response_item", "custom_tool_call") => {
            let name = payload.get("name").and_then(|value| value.as_str()).unwrap_or("tool");
            let detail = payload
                .get("arguments")
                .or_else(|| payload.get("input"))
                .and_then(|value| value.as_str())
                .unwrap_or("");
            Some(clip(&format!("→ {name} {detail}")))
        }
        ("response_item", "local_shell_call") => {
            let command = payload.pointer("/action/command").map(|value| value.to_string()).unwrap_or_default();
            Some(clip(&format!("$ {command}")))
        }
        ("event_msg", "task_complete") => payload
            .get("last_agent_message")
            .and_then(|value| value.as_str())
            .map(|text| clip(&format!("Finished: {text}"))),
        _ => None,
    }
}

fn summarize_rollout(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in text.lines() {
        let Ok(record) = serde_json::from_str::<serde_json::Value>(raw) else { continue };
        if let Some(line) = worker_line(&record) {
            // The final message is stored both as a message and in task_complete.
            if lines.last().is_some_and(|last| line.strip_prefix("Finished: ") == Some(last.as_str())) {
                continue;
            }
            lines.push(line);
        }
    }
    let skip = lines.len().saturating_sub(WORKER_LINES);
    lines.split_off(skip)
}

/// The rollout file of a thread, looked for in the newest few day folders.
fn find_rollout(sessions: &Path, thread_id: &str) -> Option<PathBuf> {
    let suffix = format!("-{thread_id}.jsonl");
    let newest_first = |dir: &Path| -> Vec<PathBuf> {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
            .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
            .unwrap_or_default();
        entries.sort();
        entries.reverse();
        entries
    };
    let mut days_checked = 0;
    for year in newest_first(sessions) {
        for month in newest_first(&year) {
            for day in newest_first(&month) {
                if days_checked >= 4 {
                    return None;
                }
                days_checked += 1;
                if let Some(found) = newest_first(&day).into_iter().find(|path| {
                    path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.ends_with(&suffix))
                }) {
                    return Some(found);
                }
            }
        }
    }
    None
}

fn read_tail(path: &Path) -> std::io::Result<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path)?;
    let length = file.metadata()?.len();
    let start = length.saturating_sub(WORKER_TAIL_BYTES);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    // A tail that starts mid-record begins with a partial line; drop it.
    Ok(if start > 0 { text.split_once('\n').map(|(_, rest)| rest.to_string()).unwrap_or_default() } else { text })
}

/// Recent activity of one Codex thread (a delegated worker), newest last.
/// Empty when the thread has not written anything yet.
#[tauri::command]
pub async fn codex_thread_activity(thread_id: String) -> Result<Vec<String>, String> {
    if !is_thread_id(&thread_id) {
        return Err("Invalid thread id".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::var("HOME").map_err(|error| format!("HOME not set: {error}"))?;
        let sessions = std::env::var("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(home).join(".codex"))
            .join("sessions");
        let Some(path) = find_rollout(&sessions, &thread_id) else { return Ok(Vec::new()) };
        read_tail(&path).map(|text| summarize_rollout(&text)).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod worker_tests {
    use super::*;

    #[test]
    fn summarizes_a_worker_rollout_into_readable_lines() {
        let rollout = [
            r#"{"type":"session_meta","payload":{"id":"x"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"do it"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":[\"ls\"]}"}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Edited the header."}]}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"Edited the header."}}"#,
            "not json",
        ]
        .join("\n");
        assert_eq!(
            summarize_rollout(&rollout),
            vec![r#"→ shell {"command":["ls"]}"#.to_string(), "Edited the header.".to_string()]
        );
    }

    #[test]
    fn finds_a_rollout_by_thread_id_and_rejects_unsafe_ids() {
        let root = std::env::temp_dir().join(format!("bs-codex-sessions-{}", std::process::id()));
        let day = root.join("2026/10/12");
        std::fs::create_dir_all(&day).unwrap();
        let id = "01a12f46-5a08-77e3-b555-07be4bd79a22";
        std::fs::write(day.join(format!("rollout-2026-10-12T14-11-42-{id}.jsonl")), "{}").unwrap();
        assert!(find_rollout(&root, id).is_some());
        assert!(find_rollout(&root, "01a12f46-0000-0000-0000-000000000000").is_none());
        assert!(is_thread_id(id));
        assert!(!is_thread_id("../../etc/passwd"));
        assert!(!is_thread_id("abc"));
        let _ = std::fs::remove_dir_all(root);
    }
}
