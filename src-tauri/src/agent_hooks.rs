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

fn our_hooks() -> [(&'static str, Value); 3] {
    [
        ("Notification", hook_entry(notification_command())),
        ("Stop", hook_entry(notify_command("Finished, waiting for you"))),
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

/// The settings a Beads Station–started session is given: only these hooks.
pub fn session_settings() -> Value {
    let hooks: Map<String, Value> = our_hooks()
        .into_iter()
        .map(|(event, entry)| (event.to_string(), json!([entry])))
        .collect();
    json!({ "hooks": hooks })
}

/// Remove this module's hooks from a settings document, leaving everything else.
pub fn without_hooks(mut settings: Value) -> Value {
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else { return settings };
    for entries in hooks.values_mut() {
        if let Some(list) = entries.as_array_mut() {
            list.retain(|entry| !is_ours(entry));
        }
    }
    hooks.retain(|_, entries| entries.as_array().map_or(true, |list| !list.is_empty()));
    if hooks.is_empty() {
        if let Some(object) = settings.as_object_mut() {
            object.remove("hooks");
        }
    }
    settings
}

/// Add this module's hooks to a settings document, once, after any the user has.
pub fn with_hooks(settings: Value) -> Result<Value, String> {
    let mut settings = without_hooks(settings);
    let object = settings.as_object_mut().ok_or("settings.json is not a JSON object")?;
    let hooks = object.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks.as_object_mut().ok_or("\"hooks\" in settings.json is not an object")?;
    for (event, entry) in our_hooks() {
        let list = hooks.entry(event).or_insert_with(|| json!([]));
        list.as_array_mut().ok_or_else(|| format!("\"hooks.{event}\" in settings.json is not a list"))?.push(entry);
    }
    Ok(settings)
}

pub fn has_hooks(settings: &Value) -> bool {
    settings
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
    let text = serde_json::to_string_pretty(&session_settings()).map_err(|error| error.to_string())?;
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
        let _ = std::fs::remove_file(file);
    }
}
