//! Local PTYs are owned by Rust; client event subscriptions are armed before
//! spawning. Window-close persistence belongs to the future runtime adapter.
use once_cell::sync::Lazy;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

struct PtyHandle {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    pid: Option<u32>,
    size: Mutex<(u16, u16)>,
    _permit: tokio::sync::OwnedSemaphorePermit,
}
static PTYS: Lazy<Mutex<HashMap<u32, Arc<PtyHandle>>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

#[derive(Clone, Serialize)]
struct PtyDataPayload {
    id: u32,
    data: String,
    /// History replayed on attach to a kept terminal: not new output.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    replay: bool,
}

/// A terminal owned by the terminal host (pty_host.rs) rather than this process.
struct HostedPty {
    key: String,
    client: Arc<crate::pty_host::HostClient>,
    _permit: tokio::sync::OwnedSemaphorePermit,
}
static HOSTED: Lazy<Mutex<HashMap<u32, Arc<HostedPty>>>> = Lazy::new(|| Mutex::new(HashMap::new()));
/// Whether hosted terminals are left running when the app quits.
static KEEP_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn hosted(id: u32) -> Option<Arc<HostedPty>> {
    HOSTED.lock().unwrap_or_else(|e| e.into_inner()).get(&id).cloned()
}
#[derive(Clone, Serialize)]
struct PtyExitPayload {
    id: u32,
}

#[derive(Clone, Serialize)]
pub struct PtySnapshot {
    id: u32,
    pid: Option<u32>,
    cols: u16,
    rows: u16,
}

/// Retain an incomplete UTF-8 suffix across arbitrary OS read boundaries.
#[derive(Default)]
pub(crate) struct Utf8Stream {
    pending: Vec<u8>,
}
impl Utf8Stream {
    pub(crate) fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        let mut consumed = 0;
        while consumed < self.pending.len() {
            let tail = &self.pending[consumed..];
            match std::str::from_utf8(tail) {
                Ok(text) => {
                    out.push_str(text);
                    consumed = self.pending.len();
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    out.push_str(
                        std::str::from_utf8(&tail[..valid]).expect("validated UTF-8 prefix"),
                    );
                    consumed += valid;
                    match error.error_len() {
                        Some(n) => {
                            out.push('\u{fffd}');
                            consumed += n;
                        }
                        None => break,
                    }
                }
            }
        }
        self.pending.drain(..consumed);
        out
    }
    pub(crate) fn finish(self) -> String {
        String::from_utf8_lossy(&self.pending).into_owned()
    }
}

fn handle(id: u32) -> Result<Arc<PtyHandle>, String> {
    PTYS.lock()
        .map_err(|e| e.to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("No terminal with id {id}"))
}

fn configure_terminal_command(cmd: &mut CommandBuilder) {
    cmd.env("LANG", "en_US.UTF-8");
    cmd.env("TERM", "xterm-256color");
    // Advertise truecolour support consistently, even when the app was
    // launched from Finder (where the inherited environment is sparse). The
    // frontend normalizes Neovim's colon-form SGR before xterm parses it.
    cmd.env("COLORTERM", "truecolor");
}

/// Path of the terminal device behind a PTY (`/dev/ttys012`).
#[cfg(unix)]
fn terminal_device(master: &dyn MasterPty) -> Option<String> {
    // ptsname returns a pointer into static storage; serialize the calls.
    static PTSNAME: Mutex<()> = Mutex::new(());
    let fd = master.as_raw_fd()?;
    let _guard = PTSNAME.lock().unwrap_or_else(|e| e.into_inner());
    // SAFETY: `fd` is this PTY's open master; the returned C string is copied
    // before the lock is released.
    unsafe {
        let name = libc::ptsname(fd);
        if name.is_null() {
            return None;
        }
        Some(std::ffi::CStr::from_ptr(name).to_string_lossy().into_owned())
    }
}
#[cfg(not(unix))]
fn terminal_device(_master: &dyn MasterPty) -> Option<String> {
    None
}

/// Everything a pane's shell is given, wherever the PTY lives.
pub(crate) fn configure_pane_command(cmd: &mut CommandBuilder, master: &dyn MasterPty) {
    configure_terminal_command(cmd);
    // Agent hooks run without a controlling terminal; this is how one
    // finds the pane it belongs to (see agent_hooks.rs).
    cmd.env("BEADS_STATION_PANE", "1");
    if let Some(tty) = terminal_device(master) {
        cmd.env("BEADS_STATION_TTY", tty);
    }
}

fn app_data_dir(window: &tauri::Window) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    window.app_handle().path().app_data_dir().map_err(|error| error.to_string())
}

/// Attach to the kept terminal named `key`, or start one in the terminal host.
fn spawn_hosted(
    window: tauri::Window,
    key: String,
    cwd: &str,
    event_key: &str,
    cols: u16,
    rows: u16,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<u32, String> {
    use serde_json::json;
    let client = crate::pty_host::client(&app_data_dir(&window)?)?;
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let (data_channel, exit_channel) = (format!("pty_data:{event_key}"), format!("pty_exit:{event_key}"));
    client.listen(&key, Box::new(move |event| {
        use crate::pty_host::HostEvent;
        let ended = match event {
            HostEvent::Data { data, replay } => {
                let _ = window.emit(&data_channel, PtyDataPayload { id, data, replay });
                false
            }
            HostEvent::Taken => {
                let data = "\r\n[this terminal was opened in another Beads Station window]\r\n".to_string();
                let _ = window.emit(&data_channel, PtyDataPayload { id, data, replay: false });
                true
            }
            HostEvent::Exit => true,
        };
        if ended {
            HOSTED.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            let _ = window.emit(&exit_channel, PtyExitPayload { id });
        }
    }));
    let alive = client
        .request(json!({ "op": "alive", "keys": [key] }))?
        .as_array()
        .is_some_and(|keys| !keys.is_empty());
    let started = if alive {
        // The replay arrives through the listener before this returns.
        client
            .request(json!({ "op": "attach", "key": key }))
            .and_then(|_| client.request(json!({ "op": "resize", "key": key, "cols": cols.max(1), "rows": rows.max(1), "redraw": true })))
    } else {
        client.request(json!({ "op": "spawn", "key": key, "cwd": cwd, "cols": cols.max(1), "rows": rows.max(1) }))
    };
    if let Err(error) = started {
        client.forget(&key);
        return Err(error);
    }
    HOSTED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, Arc::new(HostedPty { key, client, _permit: permit }));
    Ok(id)
}

#[tauri::command]
pub async fn pty_spawn(
    window: tauri::Window,
    cwd: String,
    event_key: String,
    cols: u16,
    rows: u16,
    persist_key: Option<String>,
) -> Result<u32, String> {
    if event_key.is_empty()
        || event_key.len() > 100
        || !event_key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Invalid terminal event key".into());
    }
    let mut permit = crate::spawngov::terminal_permit()?;
    // A pane that asked to be kept goes to the terminal host. If the host
    // cannot be reached the pane still gets a shell, owned by this process.
    if let Some(key) = persist_key.filter(|key| !key.is_empty()) {
        let (window, cwd, event_key) = (window.clone(), cwd.clone(), event_key.clone());
        let attempt = tauri::async_runtime::spawn_blocking(move || spawn_hosted(window, key, &cwd, &event_key, cols, rows, permit))
            .await
            .map_err(|e| e.to_string())?;
        match attempt {
            Ok(id) => return Ok(id),
            Err(error) => {
                eprintln!("[pty] terminal host unavailable, using an in-process shell: {error}");
                permit = crate::spawngov::terminal_permit()?;
            }
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty failed: {e}"))?;
        // Prepare fallible handles before launching, so a failed clone cannot orphan a child.
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let mut cmd = CommandBuilder::new("zsh");
        cmd.arg("-il");
        cmd.cwd(&cwd);
        configure_pane_command(&mut cmd, pair.master.as_ref());
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn failed: {e}"))?;
        let pid = child.process_id();
        drop(pair.slave);
        let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
        let mut map = PTYS.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(
            id,
            Arc::new(PtyHandle {
                master: Mutex::new(pair.master),
                writer: Mutex::new(writer),
                child: Mutex::new(child),
                pid,
                size: Mutex::new((cols.max(1), rows.max(1))),
                _permit: permit,
            }),
        );
        drop(map);
        std::thread::spawn(move || {
            let mut decoder = Utf8Stream::default();
            let mut buf = [0u8; 16384];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = decoder.push(&buf[..n]);
                        if !data.is_empty() {
                            let _ = window.emit(
                                &format!("pty_data:{event_key}"),
                                PtyDataPayload { id, data, replay: false },
                            );
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            let data = decoder.finish();
            if !data.is_empty() {
                let _ = window.emit(
                    &format!("pty_data:{event_key}"),
                    PtyDataPayload { id, data, replay: false },
                );
            }
            let _ = window.emit(&format!("pty_exit:{event_key}"), PtyExitPayload { id });
            let handle = PTYS.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            if let Some(handle) = handle {
                if let Ok(mut child) = handle.child.lock() {
                    let _ = child.wait();
                }
            }
        });
        Ok(id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pty_write(id: u32, data: String) -> Result<(), String> {
    if let Some(hosted) = hosted(id) {
        return tauri::async_runtime::spawn_blocking(move || {
            hosted.client.request(serde_json::json!({ "op": "write", "key": hosted.key, "data": data })).map(|_| ())
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    let handle = handle(id)?;
    // A slow terminal's stdin must not lock every other pane or the async runtime.
    tauri::async_runtime::spawn_blocking(move || {
        let mut writer = handle.writer.lock().map_err(|e| e.to_string())?;
        writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pty_resize(id: u32, cols: u16, rows: u16) -> Result<(), String> {
    if let Some(hosted) = hosted(id) {
        return tauri::async_runtime::spawn_blocking(move || {
            hosted.client.request(serde_json::json!({ "op": "resize", "key": hosted.key, "cols": cols.max(1), "rows": rows.max(1) })).map(|_| ())
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    let handle = handle(id)?;
    let master = handle.master.lock().map_err(|e| e.to_string())?;
    master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    *handle.size.lock().map_err(|e| e.to_string())? = (cols.max(1), rows.max(1));
    Ok(())
}

#[tauri::command]
pub async fn pty_snapshot(id: u32) -> Result<PtySnapshot, String> {
    if let Some(hosted) = hosted(id) {
        let snapshot = tauri::async_runtime::spawn_blocking(move || hosted.client.request(serde_json::json!({ "op": "snapshot", "key": hosted.key })))
            .await
            .map_err(|e| e.to_string())??;
        let number = |field: &str| snapshot.get(field).and_then(serde_json::Value::as_u64);
        return Ok(PtySnapshot {
            id,
            pid: number("pid").map(|pid| pid as u32),
            cols: number("cols").unwrap_or(0) as u16,
            rows: number("rows").unwrap_or(0) as u16,
        });
    }
    let handle = handle(id)?;
    let (cols, rows) = *handle.size.lock().map_err(|e| e.to_string())?;
    Ok(PtySnapshot {
        id,
        pid: handle.pid,
        cols,
        rows,
    })
}

/// Name the agent CLI in a command line, without exposing the command itself.
fn classify_agent_cli(argv: &[String]) -> Option<&'static str> {
    // `claude` is a native binary or sets its own title; `codex` is usually
    // `node …/bin/codex` wrapping a native binary. Look at the program and its
    // first argument only, so a path later in the arguments cannot match.
    argv.iter().take(2).find_map(|arg| {
        let name = arg.rsplit('/').next().unwrap_or(arg);
        if name == "claude" || arg.contains("/claude-code/") {
            Some("claude")
        } else if name == "codex" || name.starts_with("codex-") || name == "codex.js" {
            Some("codex")
        } else {
            None
        }
    })
}

#[cfg(unix)]
fn foreground_argv(master: &dyn MasterPty) -> Option<Vec<String>> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let pid = Pid::from_u32(u32::try_from(master.process_group_leader()?).ok()?);
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );
    let process = system.process(pid)?;
    Some(
        process
            .cmd()
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect(),
    )
}
#[cfg(not(unix))]
fn foreground_argv(_master: &dyn MasterPty) -> Option<Vec<String>> {
    None
}

/// The session id in a Codex rollout path: `…/sessions/2026/10/12/rollout-<time>-<uuid>.jsonl`.
fn rollout_session_id(path: &str) -> Option<&str> {
    let name = path.rsplit('/').next()?.strip_suffix(".jsonl")?;
    if !path.contains("/sessions/") || !name.starts_with("rollout-") || name.len() < 36 {
        return None;
    }
    let id = &name[name.len() - 36..];
    (id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-') && id.as_bytes()[8] == b'-').then_some(id)
}

/// Codex keeps its session file open for the life of the process. With
/// workers there are several; the primary thread's file is the oldest.
fn codex_session_from_lsof(output: &str) -> Option<String> {
    output
        .lines()
        .filter_map(|line| line.strip_prefix('n'))
        .filter(|path| rollout_session_id(path).is_some())
        .min_by_key(|path| path.rsplit('/').next().map(str::to_string))
        .and_then(rollout_session_id)
        .map(str::to_string)
}

#[cfg(unix)]
fn codex_session_id(process_group: i32) -> Option<String> {
    let output = std::process::Command::new("/usr/sbin/lsof")
        .args(["-g", &process_group.to_string(), "-Fn"])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    codex_session_from_lsof(&String::from_utf8_lossy(&output.stdout))
}
#[cfg(not(unix))]
fn codex_session_id(_process_group: i32) -> Option<String> {
    None
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyForeground {
    /// "claude" or "codex" when an agent CLI owns the terminal's foreground.
    cli: Option<String>,
    /// The exact session, when it can be read without the agent's help.
    session_id: Option<String>,
}

/// The agent CLI in a terminal's foreground and, for Codex on request (it
/// costs an `lsof`), its session.
pub(crate) fn foreground_of(master: &dyn MasterPty, want_session: bool) -> (Option<&'static str>, Option<String>) {
    let cli = foreground_argv(master).and_then(|argv| classify_agent_cli(&argv));
    let session_id = match (cli, master.process_group_leader()) {
        (Some("codex"), Some(group)) if want_session => codex_session_id(group),
        _ => None,
    };
    (cli, session_id)
}

/// Which agent CLI, if any, owns this terminal's foreground, and for Codex
/// which session. Used only to offer an explicit resume after a restart.
#[tauri::command]
pub async fn pty_foreground(id: u32, want_session: Option<bool>) -> Result<PtyForeground, String> {
    let want_session = want_session == Some(true);
    if let Some(hosted) = hosted(id) {
        let answer = tauri::async_runtime::spawn_blocking(move || {
            hosted.client.request(serde_json::json!({ "op": "foreground", "key": hosted.key, "wantSession": want_session }))
        })
        .await
        .map_err(|e| e.to_string())??;
        let field = |name: &str| answer.get(name).and_then(serde_json::Value::as_str).map(str::to_string);
        return Ok(PtyForeground { cli: field("cli"), session_id: field("sessionId") });
    }
    let handle = handle(id)?;
    let (cli, session_id) = tauri::async_runtime::spawn_blocking(move || {
        let master = handle.master.lock().unwrap_or_else(|e| e.into_inner());
        foreground_of(master.as_ref(), want_session)
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(PtyForeground { cli: cli.map(str::to_string), session_id })
}

#[tauri::command]
pub async fn pty_kill(id: u32) -> Result<(), String> {
    let hosted = HOSTED.lock().map_err(|e| e.to_string())?.remove(&id);
    if let Some(hosted) = hosted {
        hosted.client.forget(&hosted.key);
        return tauri::async_runtime::spawn_blocking(move || {
            hosted.client.request(serde_json::json!({ "op": "kill", "key": hosted.key })).map(|_| ())
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    let handle = PTYS.lock().map_err(|e| e.to_string())?.remove(&id);
    if let Some(handle) = handle {
        tauri::async_runtime::spawn_blocking(move || {
            let mut child = handle.child.lock().unwrap_or_else(|e| e.into_inner());
            let _ = child.kill();
            let _ = child.wait();
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Leave kept terminals running when the app quits (the user's setting).
#[tauri::command]
pub fn pty_set_keep_running(keep: bool) {
    KEEP_RUNNING.store(keep, Ordering::SeqCst);
}

/// Which of these kept terminals are still alive. Never starts the host.
#[tauri::command]
pub async fn pty_persisted(window: tauri::Window, keys: Vec<String>) -> Result<Vec<String>, String> {
    let app_data = app_data_dir(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(client) = crate::pty_host::existing_client(&app_data) else { return Vec::new() };
        client
            .request(serde_json::json!({ "op": "alive", "keys": keys }))
            .ok()
            .and_then(|alive| alive.as_array().map(|alive| alive.iter().filter_map(|key| key.as_str().map(str::to_string)).collect()))
            .unwrap_or_default()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Stop kept terminals whose panes were closed without ever being shown.
#[tauri::command]
pub async fn pty_release_keys(window: tauri::Window, keys: Vec<String>) -> Result<(), String> {
    let app_data = app_data_dir(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(client) = crate::pty_host::existing_client(&app_data) {
            for key in keys {
                let _ = client.request(serde_json::json!({ "op": "kill", "key": key }));
            }
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Number of terminals the terminal host is holding for this app.
pub fn hosted_pty_count() -> usize {
    HOSTED.lock().unwrap_or_else(|e| e.into_inner()).len()
}

pub fn keeps_terminals_running() -> bool {
    KEEP_RUNNING.load(Ordering::SeqCst)
}

/// Stop every terminal this app owns. Terminals held by the terminal host
/// are left running when the user has asked for that; the app only lets go.
pub fn kill_all_ptys() -> usize {
    let hosted: Vec<_> = HOSTED.lock().unwrap_or_else(|e| e.into_inner()).drain().map(|(_, hosted)| hosted).collect();
    let mut stopped = 0;
    for hosted in hosted {
        hosted.client.forget(&hosted.key);
        if !keeps_terminals_running() {
            let _ = hosted.client.request(serde_json::json!({ "op": "kill", "key": hosted.key }));
            stopped += 1;
        }
    }
    stopped + kill_local_ptys()
}

fn kill_local_ptys() -> usize {
    let handles: Vec<_> = PTYS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .drain()
        .map(|(_, h)| h)
        .collect();
    let n = handles.len();
    for handle in handles {
        let mut child = handle.child.lock().unwrap_or_else(|e| e.into_inner());
        let _ = child.kill();
        let _ = child.wait();
    }
    n
}

/// Terminals that quitting would stop.
pub fn active_pty_count() -> usize {
    let local = PTYS.lock().unwrap_or_else(|e| e.into_inner()).len();
    local + if keeps_terminals_running() { 0 } else { hosted_pty_count() }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminal_command_advertises_utf8_and_truecolor() {
        let mut cmd = CommandBuilder::new("zsh");
        configure_terminal_command(&mut cmd);
        assert_eq!(cmd.get_env("LANG").and_then(|v| v.to_str()), Some("en_US.UTF-8"));
        assert_eq!(cmd.get_env("TERM").and_then(|v| v.to_str()), Some("xterm-256color"));
        assert_eq!(cmd.get_env("COLORTERM").and_then(|v| v.to_str()), Some("truecolor"));
    }

    #[test]
    fn classifies_agent_clis_from_the_program_and_first_argument_only() {
        let argv = |parts: &[&str]| parts.iter().map(|part| part.to_string()).collect::<Vec<_>>();
        assert_eq!(classify_agent_cli(&argv(&["claude", "--continue"])), Some("claude"));
        assert_eq!(classify_agent_cli(&argv(&["/opt/homebrew/bin/claude"])), Some("claude"));
        assert_eq!(classify_agent_cli(&argv(&["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"])), Some("claude"));
        assert_eq!(classify_agent_cli(&argv(&["node", "/opt/homebrew/bin/codex", "resume"])), Some("codex"));
        assert_eq!(classify_agent_cli(&argv(&["codex-aarch64-apple-darwin"])), Some("codex"));
        assert_eq!(classify_agent_cli(&argv(&["-zsh"])), None);
        assert_eq!(classify_agent_cli(&argv(&["vim", "notes", "claude"])), None);
        assert_eq!(classify_agent_cli(&[]), None);
    }

    #[test]
    fn reads_the_primary_codex_session_from_open_files() {
        let lsof = "p123\nn/dev/ttys004\nn/home/x/.codex/sessions/2026/10/12/rollout-2026-10-12T15-24-12-01a12f88-bb49-7640-a482-4529a6771857.jsonl\nn/home/x/.codex/sessions/2026/10/12/rollout-2026-10-12T13-42-16-01a12f2b-69d8-7ea0-a23b-0fd1d81cac0e.jsonl\nn/home/x/notes/rollout-plan.jsonl\n";
        assert_eq!(codex_session_from_lsof(lsof).as_deref(), Some("01a12f2b-69d8-7ea0-a23b-0fd1d81cac0e"));
        assert_eq!(codex_session_from_lsof("p1\nn/dev/null\n"), None);
        assert_eq!(rollout_session_id("/a/sessions/rollout-short.jsonl"), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_pane_shell_is_told_which_terminal_device_it_runs_on() {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let tty = terminal_device(pair.master.as_ref()).expect("terminal device name");
        assert!(tty.starts_with("/dev/"), "{tty:?}");
        assert!(std::path::Path::new(&tty).exists());
    }

    #[cfg(unix)]
    #[test]
    fn foreground_of_a_live_pty_is_inspectable_and_a_plain_command_is_not_an_agent() {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("/bin/sleep");
        cmd.arg("5");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let argv = (0..50).find_map(|_| {
            std::thread::sleep(std::time::Duration::from_millis(20));
            foreground_argv(pair.master.as_ref()).filter(|argv| !argv.is_empty())
        });
        let _ = child.kill();
        let _ = child.wait();
        let argv = argv.expect("foreground process command line");
        assert!(argv[0].ends_with("sleep"), "{argv:?}");
        assert_eq!(classify_agent_cli(&argv), None);
    }

    #[test]
    fn unicode_and_escape_sequences_survive_every_split_boundary() {
        let text = "hello café 日本語 🦀\u{1b}[31mred\u{1b}[0m";
        for split in 0..=text.len() {
            let mut decoder = Utf8Stream::default();
            let output = decoder.push(&text.as_bytes()[..split])
                + &decoder.push(&text.as_bytes()[split..])
                + &decoder.finish();
            assert_eq!(output, text, "split {split}");
        }
    }
    #[test]
    fn invalid_bytes_are_replaced_but_incomplete_characters_wait() {
        let mut decoder = Utf8Stream::default();
        assert_eq!(decoder.push(&[0xff, b'a', 0xe2]), "\u{fffd}a");
        assert_eq!(decoder.push(&[0x82]), "");
        assert_eq!(decoder.push(&[0xac]), "€");
        assert_eq!(decoder.finish(), "");
    }
    #[test]
    fn incomplete_final_character_is_not_silently_dropped() {
        let mut decoder = Utf8Stream::default();
        assert_eq!(decoder.push(&[0xe2, 0x82]), "");
        assert_eq!(decoder.finish(), "\u{fffd}");
    }
}
