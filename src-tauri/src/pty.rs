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
    flow: Arc<OutputFlow>,
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
    /// Bytes to acknowledge with `pty_ack` once parsed. Zero when no ack is wanted.
    #[serde(skip_serializing_if = "is_zero")]
    ack: usize,
}

fn is_zero(value: &usize) -> bool {
    *value == 0
}

/// Output a pane may have on its way to the web view before its reader pauses.
const FLOW_HIGH_WATER: usize = 2 * 1024 * 1024;
const FLOW_LOW_WATER: usize = 512 * 1024;
/// A pane whose view stopped acknowledging slows down; it never hangs.
const FLOW_MAX_WAIT: std::time::Duration = std::time::Duration::from_millis(250);

/// Back-pressure from xterm to the program writing to it.
///
/// Without this a program that floods stdout (an engine log, `yes`, a build)
/// queues events in the web view faster than xterm can parse them, and that
/// memory is unbounded. Pausing the reader fills the kernel's PTY buffer, which
/// blocks the writer, exactly as a slow real terminal does. No byte is dropped.
#[derive(Default)]
struct OutputFlow {
    in_flight: Mutex<usize>,
    drained: std::sync::Condvar,
}

impl OutputFlow {
    fn sent(&self, bytes: usize) {
        *self.in_flight.lock().unwrap_or_else(|e| e.into_inner()) += bytes;
    }
    fn acknowledged(&self, bytes: usize) {
        let mut in_flight = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        *in_flight = in_flight.saturating_sub(bytes);
        if *in_flight <= FLOW_LOW_WATER {
            self.drained.notify_all();
        }
    }
    /// Called by the reader between reads.
    fn wait_for_room(&self, max_wait: std::time::Duration) {
        let in_flight = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        if *in_flight < FLOW_HIGH_WATER {
            return;
        }
        let _ = self
            .drained
            .wait_timeout_while(in_flight, max_wait, |in_flight| *in_flight > FLOW_LOW_WATER);
    }
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

// A Mac with no network name reports a made-up hostname such as
// `Unknown_f2:ac:c5:01:13:37`, which then fills every zsh prompt (%m). zsh reads
// HOST once at startup, so a tiny ZDOTDIR shim sets it to the Mac's own name
// after the user's real .zshenv has run. Nothing of the user's config is edited.
pub(crate) fn is_generated_hostname(name: &str) -> bool {
    name.starts_with("Unknown") || name.contains(':') || name.is_empty()
}

// Every pane starts `zsh -il` with ZDOTDIR pointing at a small shim folder, so
// Beads Station can (1) keep a made-up hostname out of the prompt, (2) colour
// typed commands (`BS_CMD_COLOR`) and (3) emit OSC 133 prompt marks. The shim
// never edits the user's files: each file hands ZDOTDIR back to the user's own
// value, sources the user's file of the same name, then takes ZDOTDIR again
// for the next startup file. After the last file ZDOTDIR is the user's value.
//
// zsh reads .zshenv, then .zprofile (login), .zshrc (interactive), .zlogin
// (login). `_bs_shim_dir` and `_bs_user_zdotdir` are unexported shell variables.
pub(crate) const ZSHENV_SHIM: &str = r#"# Beads Station shell shim (managed; rewritten at launch). Sources your own startup files.
_bs_shim_dir="$ZDOTDIR"
if [[ -n "${BS_USER_ZDOTDIR-}" ]]; then ZDOTDIR="$BS_USER_ZDOTDIR"; else unset ZDOTDIR; fi
unset BS_USER_ZDOTDIR
[[ -f "${ZDOTDIR:-$HOME}/.zshenv" ]] && source "${ZDOTDIR:-$HOME}/.zshenv"
[[ -n "${BS_HOSTNAME-}" ]] && HOST="$BS_HOSTNAME"
unset BS_HOSTNAME
_bs_user_zdotdir="${ZDOTDIR-}"
if [[ -o interactive ]]; then ZDOTDIR="$_bs_shim_dir"; fi
"#;

pub(crate) const ZPROFILE_SHIM: &str = r#"# Beads Station shell shim (managed). Sources your own .zprofile.
if [[ -z "${_bs_shim_dir+x}" ]]; then _bs_shim_dir="$ZDOTDIR"; _bs_user_zdotdir="${BS_USER_ZDOTDIR-}"; fi
if [[ -n "$_bs_user_zdotdir" ]]; then ZDOTDIR="$_bs_user_zdotdir"; else unset ZDOTDIR; fi
[[ -f "${ZDOTDIR:-$HOME}/.zprofile" ]] && source "${ZDOTDIR:-$HOME}/.zprofile"
_bs_user_zdotdir="${ZDOTDIR-}"
ZDOTDIR="$_bs_shim_dir"
"#;

pub(crate) const ZSHRC_SHIM: &str = r#"# Beads Station shell shim (managed). Sources your own .zshrc, then adds
# the typed-command colour and OSC 133 prompt marks after it.
if [[ -z "${_bs_shim_dir+x}" ]]; then _bs_shim_dir="$ZDOTDIR"; _bs_user_zdotdir="${BS_USER_ZDOTDIR-}"; fi
if [[ -n "$_bs_user_zdotdir" ]]; then ZDOTDIR="$_bs_user_zdotdir"; else unset ZDOTDIR; fi
[[ -f "${ZDOTDIR:-$HOME}/.zshrc" ]] && source "${ZDOTDIR:-$HOME}/.zshrc"
_bs_user_zdotdir="${ZDOTDIR-}"
if [[ -n "${BS_CMD_COLOR-}" ]]; then
  zmodload zsh/nearcolor 2>/dev/null
  zle_highlight+=(default:fg=$BS_CMD_COLOR)
fi
unset BS_CMD_COLOR
if [[ -n "${BEADS_STATION_PANE-}" ]] && autoload -Uz add-zsh-hook 2>/dev/null; then
  _bs_osc_precmd() { local _s=$?; [[ -n "${_bs_osc_ran-}" ]] && print -rn -- $'\e]133;D;'$_s$'\a'; _bs_osc_ran=1; print -rn -- $'\e]133;A\a'; return $_s }
  _bs_osc_preexec() { print -rn -- $'\e]133;C\a' }
  add-zsh-hook precmd _bs_osc_precmd
  add-zsh-hook preexec _bs_osc_preexec
fi
if [[ -o login ]]; then
  ZDOTDIR="$_bs_shim_dir"
else
  if [[ -n "$_bs_user_zdotdir" ]]; then ZDOTDIR="$_bs_user_zdotdir"; else unset ZDOTDIR; fi
  unset _bs_shim_dir _bs_user_zdotdir
fi
"#;

pub(crate) const ZLOGIN_SHIM: &str = r#"# Beads Station shell shim (managed). Sources your own .zlogin, then hands ZDOTDIR back.
if [[ -z "${_bs_shim_dir+x}" ]]; then _bs_shim_dir="$ZDOTDIR"; _bs_user_zdotdir="${BS_USER_ZDOTDIR-}"; fi
if [[ -n "$_bs_user_zdotdir" ]]; then ZDOTDIR="$_bs_user_zdotdir"; else unset ZDOTDIR; fi
[[ -f "${ZDOTDIR:-$HOME}/.zlogin" ]] && source "${ZDOTDIR:-$HOME}/.zlogin"
unset _bs_shim_dir _bs_user_zdotdir
"#;

pub(crate) const SHELL_SHIM_FILES: [(&str, &str); 4] =
    [(".zshenv", ZSHENV_SHIM), (".zprofile", ZPROFILE_SHIM), (".zshrc", ZSHRC_SHIM), (".zlogin", ZLOGIN_SHIM)];

/// Write the shim files into `dir`, replacing a file only when its text differs.
/// Each file goes through a temp name and a rename so two panes starting at once
/// never see a half-written startup file.
pub(crate) fn install_shell_shim(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    for (name, body) in SHELL_SHIM_FILES {
        let file = dir.join(name);
        if std::fs::read_to_string(&file).ok().as_deref() == Some(body) { continue }
        let temp = dir.join(format!(".{name}.tmp{}", std::process::id()));
        std::fs::write(&temp, body)?;
        std::fs::rename(&temp, &file)?;
    }
    Ok(())
}

/// `#rrggbb` only: the value ends up inside a zsh array assignment.
pub(crate) fn valid_cmd_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(unix)]
fn apply_shell_shim(cmd: &mut CommandBuilder, cmd_color: Option<&str>) {
    use std::sync::OnceLock;
    static NAME: OnceLock<Option<String>> = OnceLock::new();
    let Ok(home) = std::env::var("HOME") else { return };
    let dir = std::path::Path::new(&home).join("Library/Application Support/ai.beads-station.desktop/shell-init");
    if install_shell_shim(&dir).is_err() { return }
    let name = NAME.get_or_init(|| {
        let raw = hostname_now();
        if !is_generated_hostname(&raw) { return None }
        let local = std::process::Command::new("scutil").args(["--get", "LocalHostName"]).output().ok()
            .and_then(|out| String::from_utf8(out.stdout).ok()).map(|text| text.trim().to_string()).filter(|text| !text.is_empty());
        Some(local.unwrap_or_else(|| "mac".to_string()))
    });
    if let Some(name) = name {
        if std::env::var("SHELL").map(|shell| shell.ends_with("zsh")).unwrap_or(false) {
            cmd.env("BS_HOSTNAME", name);
        }
    }
    if let Some(color) = cmd_color.filter(|color| valid_cmd_color(color)) {
        cmd.env("BS_CMD_COLOR", color);
    }
    cmd.env("BS_USER_ZDOTDIR", std::env::var("ZDOTDIR").unwrap_or_default());
    cmd.env("ZDOTDIR", dir);
}
#[cfg(not(unix))]
fn apply_shell_shim(_cmd: &mut CommandBuilder, _cmd_color: Option<&str>) {}

#[cfg(unix)]
fn hostname_now() -> String {
    let mut buffer = [0u8; 256];
    // SAFETY: the buffer is valid for its length; gethostname NUL-terminates within it.
    let ok = unsafe { libc::gethostname(buffer.as_mut_ptr() as *mut libc::c_char, buffer.len()) } == 0;
    if !ok { return String::new() }
    let end = buffer.iter().position(|b| *b == 0).unwrap_or(buffer.len());
    String::from_utf8_lossy(&buffer[..end]).into_owned()
}

/// Everything a pane's shell is given, wherever the PTY lives.
pub(crate) fn configure_pane_command(cmd: &mut CommandBuilder, master: &dyn MasterPty, cmd_color: Option<&str>) {
    configure_terminal_command(cmd);
    // Agent hooks run without a controlling terminal; this is how one
    // finds the pane it belongs to (see agent_hooks.rs).
    cmd.env("BEADS_STATION_PANE", "1");
    apply_shell_shim(cmd, cmd_color);
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
    cmd_color: Option<&str>,
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
                let _ = window.emit(&data_channel, PtyDataPayload { id, data, replay, ack: 0 });
                false
            }
            HostEvent::Taken => {
                let data = "\r\n[this terminal was opened in another Beads Station window]\r\n".to_string();
                let _ = window.emit(&data_channel, PtyDataPayload { id, data, replay: false, ack: 0 });
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
        client.request(json!({ "op": "spawn", "key": key, "cwd": cwd, "cols": cols.max(1), "rows": rows.max(1), "cmdColor": cmd_color }))
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
    // Additive: `#rrggbb` for typed commands (BS_CMD_COLOR); None leaves them uncoloured.
    cmd_color: Option<String>,
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
        let (window, cwd, event_key, color) = (window.clone(), cwd.clone(), event_key.clone(), cmd_color.clone());
        let attempt = tauri::async_runtime::spawn_blocking(move || spawn_hosted(window, key, &cwd, &event_key, cols, rows, color.as_deref(), permit))
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
        configure_pane_command(&mut cmd, pair.master.as_ref(), cmd_color.as_deref());
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn failed: {e}"))?;
        let pid = child.process_id();
        drop(pair.slave);
        let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
        let flow = Arc::new(OutputFlow::default());
        let reader_flow = flow.clone();
        let mut map = PTYS.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(
            id,
            Arc::new(PtyHandle {
                master: Mutex::new(pair.master),
                writer: Mutex::new(writer),
                child: Mutex::new(child),
                pid,
                size: Mutex::new((cols.max(1), rows.max(1))),
                flow,
                _permit: permit,
            }),
        );
        drop(map);
        std::thread::spawn(move || {
            let mut decoder = Utf8Stream::default();
            let channel = format!("pty_data:{event_key}");
            // Larger reads mean fewer events into the web view during a flood.
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                reader_flow.wait_for_room(FLOW_MAX_WAIT);
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = decoder.push(&buf[..n]);
                        if !data.is_empty() {
                            let ack = data.len();
                            reader_flow.sent(ack);
                            let _ = window.emit(&channel, PtyDataPayload { id, data, replay: false, ack });
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            let data = decoder.finish();
            if !data.is_empty() {
                let _ = window.emit(&channel, PtyDataPayload { id, data, replay: false, ack: 0 });
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

/// xterm has parsed this much of a pane's output.
#[tauri::command]
pub fn pty_ack(id: u32, bytes: usize) {
    if let Ok(handle) = handle(id) {
        handle.flow.acknowledged(bytes);
    }
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
pub(crate) fn classify_agent_cli(argv: &[String]) -> Option<&'static str> {
    // `claude` is a native binary or sets its own title; `codex` and `gemini`
    // are usually `node …/bin/<name>` (Codex wrapping a native binary). Look at
    // the program and its first argument only, so a path later in the
    // arguments cannot match.
    argv.iter().take(2).find_map(|arg| {
        let name = arg.rsplit('/').next().unwrap_or(arg);
        if name == "claude" || arg.contains("/claude-code/") {
            Some("claude")
        } else if name == "codex" || name.starts_with("codex-") || name == "codex.js" {
            Some("codex")
        } else if name == "gemini" || arg.contains("/gemini-cli/") {
            Some("gemini")
        } else {
            None
        }
    })
}

/// One row of a process listing: enough to walk the tree.
#[derive(Clone, Debug)]
pub(crate) struct ProcessRow {
    pub pid: u32,
    pub parent: Option<u32>,
    pub argv: Vec<String>,
}

/// The agent CLI at or below a terminal's foreground process, and which
/// process it is. Wrappers (`caffeinate -i claude`, `npx`, `env`, a script)
/// put the agent below the group leader. The shallowest match wins, so the
/// agent's own children (tool shells, MCP servers) never reclassify the pane.
pub(crate) fn classify_process_tree(leader: u32, rows: &[ProcessRow]) -> Option<(&'static str, u32)> {
    let mut level = vec![leader];
    let mut seen = std::collections::HashSet::new();
    // Bounded: wrappers are a few levels deep at most.
    for _ in 0..6 {
        if level.is_empty() {
            break;
        }
        for pid in &level {
            if let Some(row) = rows.iter().find(|row| row.pid == *pid) {
                if let Some(cli) = classify_agent_cli(&row.argv) {
                    return Some((cli, *pid));
                }
            }
        }
        seen.extend(level.iter().copied());
        let mut next: Vec<u32> = rows
            .iter()
            .filter(|row| row.parent.is_some_and(|parent| level.contains(&parent)) && !seen.contains(&row.pid))
            .map(|row| row.pid)
            .collect();
        next.sort_unstable();
        level = next;
    }
    None
}

/// Whether an agent could be running below this foreground program: a
/// launcher (`caffeinate`, `env`, `npx`, `node` …) or a shell running a script
/// or `-c` (an alias wrapper such as `ccd`). A shell at its prompt, an editor
/// or a pager is not looked below: listing every process is the expensive
/// path, and a Claude inside nvim's terminal does not make the pane an agent
/// pane. Unknown wrappers are missed on purpose.
fn may_launch_agent(argv: &[String]) -> bool {
    match program_name(argv).as_deref() {
        Some("zsh" | "bash" | "sh" | "fish" | "dash" | "ksh" | "tcsh" | "nu") => {
            argv.iter().skip(1).any(|arg| arg == "-c" || !arg.starts_with('-'))
        }
        Some("caffeinate" | "env" | "nice" | "nohup" | "time" | "npx" | "npm" | "pnpm" | "yarn" | "bunx" | "bun" | "node") => true,
        _ => false,
    }
}

/// The foreground process, and the agent CLI found at or below it.
#[derive(Default)]
pub(crate) struct ForegroundProcess {
    argv: Vec<String>,
    cwd: Option<String>,
    agent: Option<(&'static str, u32)>,
}

/// The command line and working folder of the terminal's foreground process,
/// and the agent CLI (if any) running as it or below it.
#[cfg(unix)]
fn foreground_process(master: &dyn MasterPty) -> Option<ForegroundProcess> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let leader = u32::try_from(master.process_group_leader()?).ok()?;
    let pid = Pid::from_u32(leader);
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing()
            .with_cmd(UpdateKind::Always)
            .with_cwd(UpdateKind::Always),
    );
    let process = system.process(pid)?;
    let argv: Vec<String> = process.cmd().iter().map(|arg| arg.to_string_lossy().into_owned()).collect();
    let mut cwd = process.cwd().map(|cwd| cwd.to_string_lossy().into_owned());
    // Fast path: the leader is the agent, or nothing that launches one.
    let agent = match classify_agent_cli(&argv) {
        Some(cli) => Some((cli, leader)),
        None if !may_launch_agent(&argv) => None,
        None => {
            // A wrapper: one listing of every process (command lines only) to walk below it.
            system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cmd(UpdateKind::OnlyIfNotSet));
            let rows: Vec<ProcessRow> = system
                .processes()
                .iter()
                .map(|(pid, process)| ProcessRow {
                    pid: pid.as_u32(),
                    parent: process.parent().map(|parent| parent.as_u32()),
                    argv: process.cmd().iter().take(2).map(|arg| arg.to_string_lossy().into_owned()).collect(),
                })
                .collect();
            let found = classify_process_tree(leader, &rows);
            if let Some((_, agent_pid)) = found {
                // The agent's own folder: a wrapper may have changed directory first.
                let agent_pid = Pid::from_u32(agent_pid);
                system.refresh_processes_specifics(ProcessesToUpdate::Some(&[agent_pid]), false, ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always));
                if let Some(agent_cwd) = system.process(agent_pid).and_then(|process| process.cwd()) {
                    cwd = Some(agent_cwd.to_string_lossy().into_owned());
                }
            }
            found
        }
    };
    Some(ForegroundProcess { argv, cwd, agent })
}
#[cfg(not(unix))]
fn foreground_process(_master: &dyn MasterPty) -> Option<ForegroundProcess> {
    None
}

#[cfg(test)]
fn foreground_argv(master: &dyn MasterPty) -> Option<Vec<String>> {
    foreground_process(master).map(|found| found.argv)
}

/// The program's own name, without its folder or arguments: `nvim`, `zsh`.
fn program_name(argv: &[String]) -> Option<String> {
    let first = argv.first()?;
    let name = first.rsplit('/').next().unwrap_or(first).trim_start_matches('-');
    (!name.is_empty() && name.len() <= 64).then(|| name.to_string())
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
pub(crate) fn codex_session_id(process_group: i32) -> Option<String> {
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

/// Claude Code records each running session in `~/.claude/sessions/<pid>.json`.
/// Reading it gives the exact conversation of a hand-typed `claude` without
/// any hook. The file follows `/clear` and `/resume`, so it is read each time.
fn claude_session_from_registry(json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let id = value.get("sessionId")?.as_str()?;
    (id.len() == 36 && id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-') && id.as_bytes()[8] == b'-')
        .then(|| id.to_string())
}

pub(crate) fn claude_session_id(pid: i32) -> Option<String> {
    let home = std::env::var_os("HOME")?;
    let path = std::path::Path::new(&home).join(".claude/sessions").join(format!("{pid}.json"));
    // A registry entry is a few hundred bytes; refuse anything that is not.
    if std::fs::metadata(&path).ok()?.len() > 64 * 1024 {
        return None;
    }
    claude_session_from_registry(&std::fs::read_to_string(path).ok()?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyForeground {
    /// "claude", "codex" or "gemini" when an agent CLI owns the terminal's foreground.
    cli: Option<String>,
    /// The exact session, when it can be read without the agent's help.
    session_id: Option<String>,
    /// Name of the foreground program (no path, no arguments), so an editor
    /// that is already open can be reused instead of typing into a shell.
    program: Option<String>,
    /// Its working folder: what a relative path printed there is relative to.
    cwd: Option<String>,
}

pub(crate) struct Foreground {
    pub cli: Option<&'static str>,
    pub session_id: Option<String>,
    pub program: Option<String>,
    pub cwd: Option<String>,
}

/// The agent CLI in a terminal's foreground and, on request, its session:
/// Codex from its open rollout file (an `lsof`), Claude from its own registry,
/// which is named by the agent's own pid (not the group leader's when a
/// wrapper started it).
pub(crate) fn foreground_of(master: &dyn MasterPty, want_session: bool) -> Foreground {
    let ForegroundProcess { argv, cwd, agent } = foreground_process(master).unwrap_or_default();
    let cli = agent.map(|(cli, _)| cli);
    let session_id = match (agent, master.process_group_leader()) {
        (Some(("codex", _)), Some(group)) if want_session => codex_session_id(group),
        (Some(("claude", pid)), _) if want_session => i32::try_from(pid).ok().and_then(claude_session_id),
        _ => None,
    };
    Foreground { cli, session_id, program: program_name(&argv), cwd }
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
        return Ok(PtyForeground { cli: field("cli"), session_id: field("sessionId"), program: field("program"), cwd: field("cwd") });
    }
    let handle = handle(id)?;
    let found = tauri::async_runtime::spawn_blocking(move || {
        let master = handle.master.lock().unwrap_or_else(|e| e.into_inner());
        foreground_of(master.as_ref(), want_session)
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(PtyForeground { cli: found.cli.map(str::to_string), session_id: found.session_id, program: found.program, cwd: found.cwd })
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
mod flow_tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn reader_runs_freely_below_the_high_water_mark() {
        let flow = OutputFlow::default();
        flow.sent(FLOW_HIGH_WATER - 1);
        let started = Instant::now();
        flow.wait_for_room(Duration::from_secs(5));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn reader_resumes_when_the_view_catches_up() {
        let flow = Arc::new(OutputFlow::default());
        flow.sent(FLOW_HIGH_WATER * 2);
        let acknowledging = flow.clone();
        let thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            acknowledging.acknowledged(FLOW_HIGH_WATER * 2);
        });
        let started = Instant::now();
        flow.wait_for_room(Duration::from_secs(5));
        let waited = started.elapsed();
        thread.join().unwrap();
        assert!(waited >= Duration::from_millis(20) && waited < Duration::from_secs(4), "{waited:?}");
    }

    #[test]
    fn a_silent_view_only_slows_the_reader() {
        let flow = OutputFlow::default();
        flow.sent(FLOW_HIGH_WATER * 2);
        let started = Instant::now();
        flow.wait_for_room(Duration::from_millis(30));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn recognises_a_made_up_hostname() {
        assert!(super::is_generated_hostname("Unknown_f2:ac:c5:01:13:37"));
        assert!(super::is_generated_hostname("fe80::1"));
        assert!(!super::is_generated_hostname("MacBook-Air"));
    }

    #[test]
    fn the_zsh_shim_sets_host_after_the_users_zshenv() {
        let dir = std::env::temp_dir().join(format!("bs-shim-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".zshenv"), super::ZSHENV_SHIM).unwrap();
        let out = std::process::Command::new("zsh").args(["-c", "print -P %m"])
            .env("ZDOTDIR", &dir).env("BS_USER_ZDOTDIR", "").env("BS_HOSTNAME", "MacBook-Air").env("HOME", &dir).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "MacBook-Air");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn zsh_available() -> bool {
        std::process::Command::new("zsh").arg("-c").arg("true").status().map(|s| s.success()).unwrap_or(false)
    }

    // A scratch HOME with the user's own startup files, plus an installed shim.
    // `zsh_dir` is where the user's files live (their ZDOTDIR, or HOME when None).
    fn shim_sandbox(tag: &str, custom_zdotdir: bool) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("bs-shim-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let home = root.join("home");
        let user_dir = if custom_zdotdir { home.join("conf-zsh") } else { home.clone() };
        let shim = root.join("shim");
        std::fs::create_dir_all(&user_dir).unwrap();
        super::install_shell_shim(&shim).unwrap();
        std::fs::write(user_dir.join(".zshenv"), "USER_ENV=1\n").unwrap();
        std::fs::write(user_dir.join(".zprofile"), "USER_PROFILE=1\n").unwrap();
        std::fs::write(user_dir.join(".zshrc"), "USER_RC=1\nalias ll='ls -l'\nUSER_RC_ZDOTDIR=${ZDOTDIR-unset}\nzle_highlight=(region:bg=red)\n").unwrap();
        std::fs::write(user_dir.join(".zlogin"), "USER_LOGIN=1\n").unwrap();
        (home, user_dir, shim)
    }

    fn run_login_shell(home: &std::path::Path, shim: &std::path::Path, user_zdotdir: Option<&std::path::Path>, color: Option<&str>, script: &str) -> String {
        let mut command = std::process::Command::new("zsh");
        command.args(["-il", "-c", script]).env("HOME", home).env("ZDOTDIR", shim)
            .env("BS_USER_ZDOTDIR", user_zdotdir.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default())
            .env("BEADS_STATION_PANE", "1").env_remove("BS_CMD_COLOR").stdin(std::process::Stdio::null());
        if let Some(color) = color { command.env("BS_CMD_COLOR", color); }
        String::from_utf8_lossy(&command.output().unwrap().stdout).into_owned()
    }

    const PROBE: &str = r#"print -r -- "env=$USER_ENV profile=$USER_PROFILE rc=$USER_RC login=$USER_LOGIN alias=${aliases[ll]} rcz=${USER_RC_ZDOTDIR} zdotdir=${ZDOTDIR-unset} bsvars=${BS_USER_ZDOTDIR-unset}/${BS_CMD_COLOR-unset} hl=${(j:|:)zle_highlight}""#;

    #[test]
    fn the_shim_sources_every_user_startup_file_and_restores_zdotdir() {
        if !zsh_available() { return }
        let (home, _user, shim) = shim_sandbox("home", false);
        let out = run_login_shell(&home, &shim, None, None, PROBE);
        let line = out.lines().find(|l| l.starts_with("env=")).unwrap_or_else(|| panic!("no probe line in {out:?}"));
        assert_eq!(line, "env=1 profile=1 rc=1 login=1 alias=ls -l rcz=unset zdotdir=unset bsvars=unset/unset hl=region:bg=red", "{line}");
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn the_shim_follows_a_zdotdir_the_user_already_had() {
        if !zsh_available() { return }
        let (home, user, shim) = shim_sandbox("custom", true);
        let out = run_login_shell(&home, &shim, Some(&user), None, PROBE);
        let line = out.lines().find(|l| l.starts_with("env=")).unwrap_or_else(|| panic!("no probe line in {out:?}"));
        let expected = format!("env=1 profile=1 rc=1 login=1 alias=ls -l rcz={0} zdotdir={0} bsvars=unset/unset hl=region:bg=red", user.display());
        assert_eq!(line, expected);
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn the_shim_follows_a_zdotdir_set_by_the_users_zshenv() {
        if !zsh_available() { return }
        let (home, user, shim) = shim_sandbox("envset", true);
        std::fs::write(home.join(".zshenv"), format!("export ZDOTDIR={}\n", user.display())).unwrap();
        let out = run_login_shell(&home, &shim, None, None, PROBE);
        let line = out.lines().find(|l| l.starts_with("env=")).unwrap_or_else(|| panic!("no probe line in {out:?}"));
        assert!(line.starts_with("env= profile=1 rc=1 login=1 alias=ls -l"), "{line}"); // zsh reads .zshenv once, before ZDOTDIR moves
        assert!(line.contains(&format!("zdotdir={}", user.display())), "{line}");
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn typed_command_colour_is_added_after_the_users_zshrc_only_when_asked() {
        if !zsh_available() { return }
        let (home, _user, shim) = shim_sandbox("color", false);
        let with = run_login_shell(&home, &shim, None, Some("#fd9f4d"), PROBE);
        let line = with.lines().find(|l| l.starts_with("env=")).unwrap_or_else(|| panic!("no probe line in {with:?}"));
        assert!(line.ends_with("bsvars=unset/unset hl=region:bg=red|default:fg=#fd9f4d"), "{line}");
        let without = run_login_shell(&home, &shim, None, None, PROBE);
        assert!(!without.contains("default:fg"), "{without}");
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn shim_file_text_matches_the_contract() {
        assert!(ZSHRC_SHIM.contains("zle_highlight+=(default:fg=$BS_CMD_COLOR)"));
        assert!(ZSHRC_SHIM.contains("if [[ -n \"${BS_CMD_COLOR-}\" ]]"));
        assert!(ZSHRC_SHIM.contains("add-zsh-hook precmd") && ZSHRC_SHIM.contains("add-zsh-hook preexec"));
        assert!(ZSHRC_SHIM.contains("133;A") && ZSHRC_SHIM.contains("133;C") && ZSHRC_SHIM.contains("133;D"));
        assert!(ZPROFILE_SHIM.contains(".zprofile") && ZLOGIN_SHIM.contains(".zlogin") && ZSHRC_SHIM.contains(".zshrc") && ZSHENV_SHIM.contains(".zshenv"));
        assert!(valid_cmd_color("#fd9f4d") && !valid_cmd_color("#fd9f4") && !valid_cmd_color("red") && !valid_cmd_color("#gg9f4d") && !valid_cmd_color("#fd9f4d);x"));
    }

    #[test]
    fn installing_the_shim_twice_is_harmless_and_repairs_edits() {
        let dir = std::env::temp_dir().join(format!("bs-shim-install-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        super::install_shell_shim(&dir).unwrap();
        std::fs::write(dir.join(".zshrc"), "broken").unwrap();
        super::install_shell_shim(&dir).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(".zshrc")).unwrap(), ZSHRC_SHIM);
        let _ = std::fs::remove_dir_all(&dir);
    }

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
    fn names_the_foreground_program_without_its_path_or_arguments() {
        let argv = |parts: &[&str]| parts.iter().map(|part| part.to_string()).collect::<Vec<_>>();
        assert_eq!(program_name(&argv(&["/opt/homebrew/bin/nvim", "+12", "notes.md"])).as_deref(), Some("nvim"));
        assert_eq!(program_name(&argv(&["-zsh"])).as_deref(), Some("zsh"));
        assert_eq!(program_name(&[]), None);
    }

    #[test]
    fn reads_a_claude_session_id_from_its_registry_entry_and_rejects_anything_else() {
        let id = "0123abcd-0123-4abc-8def-0123456789ab";
        assert_eq!(claude_session_from_registry(&format!(r#"{{"pid":7,"sessionId":"{id}","cwd":"/tmp"}}"#)).as_deref(), Some(id));
        assert_eq!(claude_session_from_registry(r#"{"sessionId":"../../etc/passwd"}"#), None);
        assert_eq!(claude_session_from_registry(r#"{"pid":7}"#), None);
        assert_eq!(claude_session_from_registry("not json"), None);
    }

    #[test]
    fn classifies_agent_clis_from_the_program_and_first_argument_only() {
        let argv = |parts: &[&str]| parts.iter().map(|part| part.to_string()).collect::<Vec<_>>();
        assert_eq!(classify_agent_cli(&argv(&["claude", "--continue"])), Some("claude"));
        assert_eq!(classify_agent_cli(&argv(&["/opt/homebrew/bin/claude"])), Some("claude"));
        assert_eq!(classify_agent_cli(&argv(&["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"])), Some("claude"));
        assert_eq!(classify_agent_cli(&argv(&["node", "/opt/homebrew/bin/codex", "resume"])), Some("codex"));
        assert_eq!(classify_agent_cli(&argv(&["codex-aarch64-apple-darwin"])), Some("codex"));
        assert_eq!(classify_agent_cli(&argv(&["node", "/opt/homebrew/bin/gemini"])), Some("gemini"));
        assert_eq!(classify_agent_cli(&argv(&["node", "/x/node_modules/@google/gemini-cli/dist/index.js"])), Some("gemini"));
        assert_eq!(classify_agent_cli(&argv(&["-zsh"])), None);
        assert_eq!(classify_agent_cli(&argv(&["vim", "notes", "claude"])), None);
        assert_eq!(classify_agent_cli(&[]), None);
    }

    #[test]
    fn finds_an_agent_below_a_wrapper_but_not_the_agents_own_children() {
        let row = |pid: u32, parent: u32, argv: &[&str]| ProcessRow { pid, parent: Some(parent), argv: argv.iter().map(|a| a.to_string()).collect() };
        let rows = vec![
            row(10, 1, &["caffeinate", "-i"]),
            row(11, 10, &["/bin/sh", "/usr/local/bin/ccd"]),
            row(12, 11, &["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"]),
            // Claude's own tool shell running codex is deeper, so it does not win.
            row(13, 12, &["codex", "exec"]),
            row(20, 1, &["npm", "exec"]),
            row(21, 20, &["node", "/opt/homebrew/lib/node_modules/@google/gemini-cli/dist/index.js"]),
            row(30, 1, &["env", "FOO=1"]),
            row(31, 30, &["/opt/homebrew/bin/codex"]),
            row(40, 1, &["make", "test"]),
            row(41, 40, &["cargo", "test", "claude"]),
        ];
        assert_eq!(classify_process_tree(10, &rows), Some(("claude", 12)));
        assert_eq!(classify_process_tree(12, &rows), Some(("claude", 12)));
        assert_eq!(classify_process_tree(20, &rows), Some(("gemini", 21)));
        assert_eq!(classify_process_tree(30, &rows), Some(("codex", 31)));
        assert_eq!(classify_process_tree(40, &rows), None);
        assert_eq!(classify_process_tree(99, &rows), None);
        // A cycle in a bad listing cannot loop forever.
        let cycle = vec![row(1, 2, &["a"]), row(2, 1, &["b"])];
        assert_eq!(classify_process_tree(1, &cycle), None);
    }

    #[test]
    fn looks_below_launchers_and_script_shells_only() {
        let argv = |parts: &[&str]| parts.iter().map(|part| part.to_string()).collect::<Vec<_>>();
        for idle in [&["-zsh"][..], &["zsh", "-l"], &["/bin/bash", "--login", "-i"], &["nvim", "notes.md"], &["less"], &["htop"], &["make", "test"], &[]] {
            assert!(!may_launch_agent(&argv(idle)), "{idle:?}");
        }
        for launcher in [&["sh", "/usr/local/bin/ccd"][..], &["bash", "-c", "claude"], &["/bin/zsh", "~/bin/gpt"], &["caffeinate", "-i"], &["npm", "exec"], &["node", "/opt/homebrew/bin/npx"], &["/usr/bin/env", "FOO=1"]] {
            assert!(may_launch_agent(&argv(launcher)), "{launcher:?}");
        }
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
