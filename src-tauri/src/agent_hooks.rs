//! Exact "waiting for you" and "finished" signals from Claude Code, and the
//! session id a pane is running, delivered by Claude Code hooks.
//!
//! A hook runs detached from the terminal, so `/dev/tty` is not available to
//! it. Every pane's shell therefore carries `BEADS_STATION_TTY`, the path of
//! its own terminal device, and the hook writes an escape sequence there. The
//! pane reads it like any other terminal output. Outside Beads Station the
//! variable is unset and the hooks do nothing.
//!
//! Two ways to get the hooks into a session, both explicit:
//! - sessions the app starts pass `claude --settings <file>` (nothing of the
//!   user's is modified);
//! - for `claude` typed by hand, the user can add the same hooks to
//!   `~/.claude/settings.json` from Settings, and remove them again.
//!
//! The same two routes install a status line wrapper that reports context
//! and limit use (see "status line" below) around the user's own status line.
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Present in every command this module writes; how installed hooks are found again.
const MARKER: &str = "BEADS_STATION_TTY";

/// OSC 777 is the desktop-notification sequence panes already understand.
fn notify_command(message: &str) -> String {
    format!(
        "[ -w \"${MARKER}\" ] && printf '\\033]777;notify;Claude Code;{message}\\007' > \"${MARKER}\" 2>/dev/null; true"
    )
}

/// A subagent finished. Panes treat this wording as a sound-only event.
fn subagent_command() -> String {
    notify_command("Subagent finished")
}

/// The Notification hook carries Claude's own wording ("needs your permission to use Bash").
fn notification_command() -> String {
    format!(
        "[ -w \"${MARKER}\" ] && {{ m=$(sed -n 's/.*\"message\":\"\\([^\"]*\\)\".*/\\1/p' | head -1); printf '\\033]777;notify;Claude Code;%s\\007' \"${{m:-Needs your attention}}\" > \"${MARKER}\"; }} 2>/dev/null; true"
    )
}

/// OSC 7770 is private to Beads Station: which session this pane is running.
fn session_command() -> String {
    format!(
        "[ -w \"${MARKER}\" ] && {{ id=$(sed -n 's/.*\"session_id\":\"\\([^\"]*\\)\".*/\\1/p' | head -1); printf '\\033]7770;session;claude;%s\\007' \"$id\" > \"${MARKER}\"; }} 2>/dev/null; true"
    )
}

fn hook_entry(command: String) -> Value {
    json!({ "hooks": [{ "type": "command", "command": command }] })
}

fn our_hooks() -> [(&'static str, Value); 4] {
    [
        ("Notification", hook_entry(notification_command())),
        ("Stop", hook_entry(notify_command("Finished, waiting for you"))),
        ("SubagentStop", hook_entry(subagent_command())),
        ("SessionStart", hook_entry(session_command())),
    ]
}

fn is_ours(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hooks| {
            hooks.iter().any(|hook| {
                hook.get("command").and_then(Value::as_str).is_some_and(|command| command.contains(MARKER))
            })
        })
}

// ---------- status line ----------
//
// Claude Code pipes a JSON description of the session (context window use,
// 5-hour and weekly limits, session id) into the `statusLine` command and
// prints what it writes. The wrapper below forwards a small subset of that to
// the pane as `OSC 7770;usage;claude;{json}`, only when it changed, and then
// runs the user's own status line command on the same input, so their line
// keeps working. Outside a pane it only runs their command.
//
// `statusLine` is one value, not a list: the user's original entry is carried
// inside the wrapper as a trailing shell comment (hex of its exact JSON), so
// removing the wrapper restores it byte for byte without any other file.

/// Ends the wrapper command; what follows is the hex of the user's original entry.
const ORIGINAL_TAG: &str = "# beads-station-original:";

fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

fn hex_encode(text: &str) -> String {
    text.bytes().map(|byte| format!("{byte:02x}")).collect()
}

fn hex_decode(text: &str) -> Option<String> {
    if text.len() % 2 != 0 {
        return None;
    }
    let bytes = (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(text.get(index..index + 2)?, 16).ok())
        .collect::<Option<Vec<u8>>>()?;
    String::from_utf8(bytes).ok()
}

/// The part that reports usage to the pane. POSIX sh, sed, grep -E, paste:
/// no jq. Values are pulled out by pattern, so the payload stays small and
/// only changes when a number that matters does (not on every cost tick).
fn usage_report() -> String {
    [
        "d=$(cat);",
        &format!("[ -w \"${MARKER}\" ] && {{"),
        "c=$(printf '%s' \"$d\" | tr -d ' \\t\\r\\n');",
        // Rate-limit windows are flat objects; context use is the used_percentage outside them.
        "p=$( { printf '%s' \"$c\" | grep -oE '\"(session_id\":\"[0-9a-fA-F-]+\"|context_window_size\":[0-9]+|(five_hour|seven_day)\":\\{[^}]*\\})';",
        "printf '%s' \"$c\" | sed -E 's/\"(five_hour|seven_day)\":\\{[^}]*\\}//g' | grep -oE '\"used_percentage\":[0-9.]+' | head -n 1; } | paste -sd, -);",
        &format!("s=\"${{TMPDIR:-/tmp}}/bs-statusline-$(printf '%s' \"${MARKER}\" | tr -c 'A-Za-z0-9' '_')\";"),
        &format!("[ -n \"$p\" ] && [ \"$p\" != \"$(cat \"$s\" 2>/dev/null)\" ] && printf '\\033]7770;usage;claude;{{%s}}\\007' \"$p\" > \"${MARKER}\" && printf '%s' \"$p\" > \"$s\";"),
        "} 2>/dev/null;",
    ]
    .join(" ")
}

fn is_our_statusline(entry: &Value) -> bool {
    entry.get("command").and_then(Value::as_str).is_some_and(|command| command.contains(MARKER))
}

/// The user's own entry that a wrapper carries, if it carries one.
fn original_statusline(entry: &Value) -> Option<Value> {
    let command = entry.get("command")?.as_str()?;
    let (_, hex) = command.rsplit_once(ORIGINAL_TAG)?;
    serde_json::from_str(&hex_decode(hex.trim())?).ok()
}

/// What the user's status line is, seen through any wrapper of ours.
fn users_statusline(settings: &Value) -> Option<Value> {
    let entry = settings.get("statusLine")?;
    if is_our_statusline(entry) { original_statusline(entry) } else { Some(entry.clone()) }
}

/// The wrapper entry around the user's original (which keeps its other fields, e.g. `padding`).
fn statusline_entry(original: Option<&Value>) -> Value {
    // Never chain to a wrapper: that would report twice and nest forever.
    let chained = original
        .and_then(|entry| entry.get("command"))
        .and_then(Value::as_str)
        .filter(|command| !command.contains(MARKER) && !command.trim().is_empty());
    let mut command = usage_report();
    match chained {
        Some(users) => command.push_str(&format!(" printf '%s' \"$d\" | /bin/sh -c {}", shell_quote(users))),
        None => command.push_str(" true"),
    }
    if let Some(original) = original {
        command.push_str(&format!(" {ORIGINAL_TAG}{}", hex_encode(&original.to_string())));
    }
    let mut entry = original.and_then(Value::as_object).cloned().unwrap_or_default();
    entry.insert("type".into(), json!("command"));
    entry.insert("command".into(), json!(command));
    Value::Object(entry)
}

/// The settings a Beads Station–started session is given: these hooks, and
/// the status line wrapped around the user's own (given here because
/// `--settings` replaces their `statusLine` rather than merging with it).
pub fn session_settings(users_statusline: Option<&Value>) -> Value {
    let hooks: Map<String, Value> = our_hooks()
        .into_iter()
        .map(|(event, entry)| (event.to_string(), json!([entry])))
        .collect();
    json!({ "hooks": hooks, "statusLine": statusline_entry(users_statusline) })
}

/// Remove this module's hooks and status line wrapper from a settings
/// document, restoring the user's own status line and leaving everything else.
pub fn without_hooks(mut settings: Value) -> Value {
    if let Some(object) = settings.as_object_mut() {
        if object.get("statusLine").is_some_and(is_our_statusline) {
            match object.get("statusLine").and_then(original_statusline) {
                Some(original) => { object.insert("statusLine".into(), original); }
                None => { object.shift_remove("statusLine"); }
            }
        }
    }
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else { return settings };
    for entries in hooks.values_mut() {
        if let Some(list) = entries.as_array_mut() {
            list.retain(|entry| !is_ours(entry));
        }
    }
    hooks.retain(|_, entries| entries.as_array().map_or(true, |list| !list.is_empty()));
    if hooks.is_empty() {
        if let Some(object) = settings.as_object_mut() {
            object.shift_remove("hooks");
        }
    }
    settings
}

/// Add this module's hooks to a settings document, once, after any the user
/// has, and wrap their status line (keeping it inside the wrapper).
pub fn with_hooks(settings: Value) -> Result<Value, String> {
    let mut settings = without_hooks(settings);
    let object = settings.as_object_mut().ok_or("settings.json is not a JSON object")?;
    let hooks = object.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks.as_object_mut().ok_or("\"hooks\" in settings.json is not an object")?;
    for (event, entry) in our_hooks() {
        let list = hooks.entry(event).or_insert_with(|| json!([]));
        list.as_array_mut().ok_or_else(|| format!("\"hooks.{event}\" in settings.json is not a list"))?.push(entry);
    }
    // In place when the user has one, so the key keeps its position.
    let original = object.get("statusLine").cloned();
    object.insert("statusLine".into(), statusline_entry(original.as_ref()));
    Ok(settings)
}

pub fn has_hooks(settings: &Value) -> bool {
    settings.get("statusLine").is_some_and(is_our_statusline)
        || settings
            .get("hooks")
            .and_then(Value::as_object)
            .is_some_and(|hooks| hooks.values().filter_map(Value::as_array).flatten().any(is_ours))
}

fn user_settings_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|error| format!("HOME not set: {error}"))?;
    Ok(PathBuf::from(home).join(".claude").join("settings.json"))
}

fn read_settings(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(json!({})),
        Ok(text) => serde_json::from_str(&text).map_err(|error| format!("{} is not valid JSON: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(format!("read {}: {error}", path.display())),
    }
}

/// Replace the file through a temporary sibling, keeping one backup of the previous content.
fn write_settings(path: &Path, settings: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or("settings path has no parent")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    if path.exists() {
        std::fs::copy(path, path.with_extension("json.beads-station-backup")).map_err(|error| format!("back up settings: {error}"))?;
    }
    let mut text = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    text.push('\n');
    let temporary = path.with_extension("json.beads-station-tmp");
    std::fs::write(&temporary, text).map_err(|error| format!("write settings: {error}"))?;
    std::fs::rename(&temporary, path).map_err(|error| format!("replace settings: {error}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHooksStatus {
    /// The hooks are in the user's own Claude Code settings.
    installed: bool,
    /// Settings file for sessions the app starts itself.
    session_settings: String,
}

fn prepare_session_settings(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|error| error.to_string())?.join("agent-hooks");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join("claude-settings.json");
    // The user's own status line as it is now, so app-started sessions keep showing it.
    let users = user_settings_path().ok().and_then(|path| read_settings(&path).ok()).and_then(|settings| users_statusline(&settings));
    let text = serde_json::to_string_pretty(&session_settings(users.as_ref())).map_err(|error| error.to_string())?;
    // Rewritten only when it differs, so an update to the hooks reaches old installs.
    if std::fs::read_to_string(&path).ok().as_deref() != Some(text.as_str()) {
        std::fs::write(&path, text).map_err(|error| error.to_string())?;
    }
    Ok(path)
}

fn status(app: &tauri::AppHandle) -> Result<AgentHooksStatus, String> {
    Ok(AgentHooksStatus {
        installed: has_hooks(&read_settings(&user_settings_path()?)?),
        session_settings: prepare_session_settings(app)?.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn agent_hooks_status(app: tauri::AppHandle) -> Result<AgentHooksStatus, String> {
    status(&app)
}

/// Add (or remove) the hooks in `~/.claude/settings.json`. Only ever called from a button.
#[tauri::command]
pub fn agent_hooks_set_installed(app: tauri::AppHandle, installed: bool) -> Result<AgentHooksStatus, String> {
    let path = user_settings_path()?;
    let current = read_settings(&path)?;
    let next = if installed { with_hooks(current.clone())? } else { without_hooks(current.clone()) };
    if next != current {
        write_settings(&path, &next)?;
    }
    status(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_hooks_after_the_users_own_and_removes_only_its_own() {
        let users = json!({
            "model": "opus",
            "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }] },
            "permissions": { "allow": ["Bash(ls:*)"] }
        });
        let installed = with_hooks(users.clone()).unwrap();
        assert!(has_hooks(&installed));
        assert_eq!(installed["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(installed["hooks"]["Stop"][0], users["hooks"]["Stop"][0]);
        assert_eq!(installed["hooks"]["Notification"].as_array().unwrap().len(), 1);
        assert_eq!(installed["hooks"]["SubagentStop"].as_array().unwrap().len(), 1);
        assert!(without_hooks(installed.clone()).get("hooks").unwrap().get("SubagentStop").is_none());
        assert_eq!(installed["model"], "opus");
        // Installing twice does not duplicate.
        assert_eq!(with_hooks(installed.clone()).unwrap(), installed);
        assert_eq!(without_hooks(installed), users);
    }

    #[test]
    fn removing_from_settings_without_hooks_leaves_no_empty_section() {
        let installed = with_hooks(json!({ "theme": "dark" })).unwrap();
        assert_eq!(without_hooks(installed), json!({ "theme": "dark" }));
        assert!(!has_hooks(&json!({})));
        assert!(with_hooks(json!([])).is_err());
        assert!(with_hooks(json!({ "hooks": [] })).is_err());
    }

    #[test]
    fn key_order_of_the_users_settings_is_kept() {
        let users: Value = serde_json::from_str(r#"{"zeta":1,"alpha":2,"hooks":{"Stop":[]},"middle":3}"#).unwrap();
        let text = serde_json::to_string(&without_hooks(with_hooks(users).unwrap())).unwrap();
        assert!(text.find("zeta").unwrap() < text.find("alpha").unwrap());
        assert!(text.find("alpha").unwrap() < text.find("middle").unwrap());
    }

    #[test]
    fn wraps_the_users_status_line_once_and_restores_it_exactly() {
        let users: Value = serde_json::from_str(r#"{"model":"opus","statusLine":{"type":"command","command":"~/.claude/statusline.sh","padding":0},"theme":"dark"}"#).unwrap();
        let installed = with_hooks(users.clone()).unwrap();
        let entry = &installed["statusLine"];
        assert!(is_our_statusline(entry));
        assert_eq!(entry["padding"], 0);
        let command = entry["command"].as_str().unwrap();
        assert!(command.contains("/bin/sh -c '~/.claude/statusline.sh'"), "{command}");
        // Installing again wraps the original, not the wrapper.
        let twice = with_hooks(installed.clone()).unwrap();
        assert_eq!(twice, installed);
        assert_eq!(twice["statusLine"]["command"].as_str().unwrap().matches(MARKER).count(), command.matches(MARKER).count());
        // Removing restores the exact entry, in its place.
        let restored = without_hooks(installed);
        assert_eq!(restored, users);
        assert_eq!(serde_json::to_string(&restored).unwrap(), serde_json::to_string(&users).unwrap());
    }

    #[test]
    fn a_status_line_is_added_and_removed_when_the_user_had_none() {
        let installed = with_hooks(json!({ "theme": "dark" })).unwrap();
        assert!(installed["statusLine"]["command"].as_str().unwrap().ends_with(" true"));
        assert_eq!(without_hooks(installed), json!({ "theme": "dark" }));
        // Only the status line left (hooks removed by hand) still counts as installed.
        let only_line = json!({ "statusLine": statusline_entry(None) });
        assert!(has_hooks(&only_line));
        assert_eq!(without_hooks(only_line), json!({}));
    }

    #[test]
    fn app_started_sessions_chain_to_the_users_status_line_seen_through_a_wrapper() {
        let users = json!({ "type": "command", "command": "printf hi" });
        let installed = with_hooks(json!({ "statusLine": users.clone() })).unwrap();
        assert_eq!(users_statusline(&installed), Some(users.clone()));
        let settings = session_settings(users_statusline(&installed).as_ref());
        let command = settings["statusLine"]["command"].as_str().unwrap();
        assert!(command.contains("/bin/sh -c 'printf hi'"));
        // A wrapper is never chained to.
        let wrapper = statusline_entry(None);
        assert!(!statusline_entry(Some(&wrapper))["command"].as_str().unwrap().contains("/bin/sh -c"));
        assert_eq!(hex_decode(&hex_encode("é'\"x")).as_deref(), Some("é'\"x"));
        assert_eq!(hex_decode("zz"), None);
    }

    #[test]
    fn status_line_reports_usage_once_per_change_and_keeps_the_users_output() {
        use std::io::Write;
        let scratch = std::env::temp_dir().join(format!("bs-statusline-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&scratch);
        std::fs::create_dir_all(&scratch).unwrap();
        let tty = scratch.join("tty");
        std::fs::write(&tty, "").unwrap();
        let original = json!({ "type": "command", "command": "cat > /dev/null; printf 'Context: 7%% used'" });
        let command = statusline_entry(Some(&original))["command"].as_str().unwrap().to_string();
        let run = |stdin: &str, tty: Option<&Path>| -> String {
            let mut shell = std::process::Command::new("/bin/sh");
            shell.arg("-c").arg(&command).env("TMPDIR", &scratch).env_remove(MARKER)
                .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped());
            if let Some(tty) = tty { shell.env(MARKER, tty); }
            let mut child = shell.spawn().unwrap();
            child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
            let output = child.wait_with_output().unwrap();
            String::from_utf8(output.stdout).unwrap()
        };
        let input = r#"{"session_id":"2c975569-13c1-43b2-8e7a-f88d6138d7d8","transcript_path":"/x/y.jsonl","cwd":"/x","model":{"id":"claude-opus","display_name":"Opus"},"cost":{"total_cost_usd":1.5,"total_duration_ms":4321},"context_window":{"total_input_tokens":1200,"context_window_size":200000,"current_usage":{"input_tokens":10,"cache_read_input_tokens":80000},"used_percentage":42,"remaining_percentage":58},"rate_limits":{"five_hour":{"used_percentage":81.5,"resets_at":1763650800},"seven_day":{"used_percentage":69,"resets_at":1764000000}}}"#;

        assert_eq!(run(input, Some(&tty)), "Context: 7% used");
        let written = std::fs::read_to_string(&tty).unwrap();
        let payload = written.strip_prefix("\u{1b}]7770;usage;claude;").and_then(|rest| rest.strip_suffix('\u{7}')).expect(&written);
        let parsed: Value = serde_json::from_str(payload).expect(payload);
        assert_eq!(parsed["session_id"], "2c975569-13c1-43b2-8e7a-f88d6138d7d8");
        assert_eq!(parsed["used_percentage"], 42);
        assert_eq!(parsed["context_window_size"], 200000);
        assert_eq!(parsed["five_hour"]["used_percentage"], 81.5);
        assert_eq!(parsed["seven_day"]["resets_at"], 1764000000);
        assert!(!payload.contains("cost") && !payload.contains("/x"), "{payload}");

        // Only the cost moved: nothing new is written.
        std::fs::write(&tty, "").unwrap();
        assert_eq!(run(&input.replace("4321", "9876"), Some(&tty)), "Context: 7% used");
        assert_eq!(std::fs::read_to_string(&tty).unwrap(), "");
        // Context use moved: reported again.
        run(&input.replace("\"used_percentage\":42", "\"used_percentage\":43"), Some(&tty));
        assert!(std::fs::read_to_string(&tty).unwrap().contains("\"used_percentage\":43"));

        // Older Claude Code without the new fields, and null limits: nothing invalid is sent.
        std::fs::write(&tty, "").unwrap();
        run(r#"{"session_id":"0123abcd-0123-4abc-8def-0123456789ab","rate_limits":null,"context_window":{"used_percentage":null}}"#, Some(&tty));
        let written = std::fs::read_to_string(&tty).unwrap();
        let payload = written.strip_prefix("\u{1b}]7770;usage;claude;").and_then(|rest| rest.strip_suffix('\u{7}')).unwrap();
        assert_eq!(serde_json::from_str::<Value>(payload).unwrap(), json!({ "session_id": "0123abcd-0123-4abc-8def-0123456789ab" }));

        // Outside a pane (iTerm, a plain terminal): only the user's own line.
        assert_eq!(run(input, None), "Context: 7% used");
        // No original command: prints nothing.
        let bare = statusline_entry(None)["command"].as_str().unwrap().to_string();
        let output = std::process::Command::new("/bin/sh").arg("-c").arg(&bare).env_remove(MARKER).stdin(std::process::Stdio::null()).output().unwrap();
        assert!(output.stdout.is_empty() && output.status.success());
        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[test]
    fn hook_commands_do_nothing_outside_a_pane_and_signal_inside_one() {
        let run = |command: &str, tty: Option<&Path>, stdin: &str| {
            use std::io::Write;
            let mut shell = std::process::Command::new("/bin/sh");
            shell.arg("-c").arg(command).stdin(std::process::Stdio::piped()).env_remove(MARKER);
            if let Some(tty) = tty {
                shell.env(MARKER, tty);
            }
            let mut child = shell.spawn().unwrap();
            child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
            assert!(child.wait().unwrap().success());
        };
        let file = std::env::temp_dir().join(format!("bs-agent-hook-{}", std::process::id()));
        std::fs::write(&file, "").unwrap();

        run(&session_command(), None, r#"{"session_id":"abc"}"#);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "");

        run(&session_command(), Some(&file), r#"{"session_id":"2c975569-13c1-43b2-8e7a-f88d6138d7d8","cwd":"/x"}"#);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "\u{1b}]7770;session;claude;2c975569-13c1-43b2-8e7a-f88d6138d7d8\u{7}");

        run(&notification_command(), Some(&file), r#"{"hook_event_name":"Notification","message":"Claude needs your permission to use Bash"}"#);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "\u{1b}]777;notify;Claude Code;Claude needs your permission to use Bash\u{7}");

        run(&notify_command("Finished, waiting for you"), Some(&file), "{}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "\u{1b}]777;notify;Claude Code;Finished, waiting for you\u{7}");

        run(&subagent_command(), Some(&file), "{}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "\u{1b}]777;notify;Claude Code;Subagent finished\u{7}");
        let _ = std::fs::remove_file(file);
    }
}
