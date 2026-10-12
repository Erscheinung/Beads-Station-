//! Terminal host: a small background process that owns shells so they outlive
//! the app (Code-6un.3).
//!
//! The host is this same executable started with `--pty-host <socket>`. It
//! holds the PTYs, keeps draining their output into a bounded history, and
//! serves one or more app processes over a Unix socket. When the app quits,
//! crashes or is replaced by an update, the host and its shells keep running;
//! the next launch attaches to them and replays the history.
//!
//! What it does not survive: logout, restart, shutdown, or the host itself
//! being killed. Each terminal is known only by a random key held in the
//! host's memory, so a pane can never be attached to anything but the exact
//! shell it started; if the host is gone the key is simply unknown.
//!
//! Protocol (version 1): one JSON object per line.
//!   request   {"id":N,"op":"…",…}      → {"id":N,"ok":true,"result":…}
//!                                       → {"id":N,"ok":false,"error":"…"}
//!   event     {"event":"data","key":K,"data":"…","replay":bool}
//!             {"event":"exit","key":K}
//!             {"event":"taken","key":K}   another client attached this terminal
//! Changes must stay additive: an updated app has to talk to a host that an
//! older version started.

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

pub const PROTOCOL: u64 = 1;
pub const HOST_FLAG: &str = "--pty-host";
/// Output kept per terminal for replay on attach.
const HISTORY_BYTES: usize = 512 * 1024;
const MAX_TERMINALS: usize = 64;
/// A host with no terminals and no app connected exits after this long.
const IDLE_EXIT: Duration = Duration::from_secs(20);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ── terminal modes ──────────────────────────────────────────────────────────
// A program that switched to the alternate screen or turned on mouse reporting
// did so once, possibly long before the history that is replayed. The host
// tracks those switches and restates them after a replay.

const TRACKED_MODES: &[u32] = &[1, 25, 47, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1047, 1049, 2004];

/// Record every `CSI ? … h` / `CSI ? … l` in `text` for the modes we track.
fn track_modes(modes: &mut BTreeMap<u32, bool>, text: &str) {
    let bytes = text.as_bytes();
    let mut index = 0;
    while let Some(offset) = text[index..].find("\u{1b}[?") {
        let start = index + offset + 3;
        let mut end = start;
        while end < bytes.len() && (bytes[end].is_ascii_digit() || bytes[end] == b';') {
            end += 1;
        }
        if end < bytes.len() && (bytes[end] == b'h' || bytes[end] == b'l') {
            let on = bytes[end] == b'h';
            for mode in text[start..end].split(';').filter_map(|part| part.parse::<u32>().ok()) {
                if TRACKED_MODES.contains(&mode) {
                    modes.insert(mode, on);
                }
            }
        }
        index = end.min(bytes.len());
        if index >= bytes.len() {
            break;
        }
    }
}

/// Escape sequences that put a fresh terminal into the recorded modes.
fn restate_modes(modes: &BTreeMap<u32, bool>) -> String {
    modes
        .iter()
        // Off is a new terminal's default for everything but the cursor (25).
        .filter(|(mode, on)| **on != (**mode == 25))
        .map(|(mode, on)| format!("\u{1b}[?{mode}{}", if *on { 'h' } else { 'l' }))
        .collect()
}

// ── host ────────────────────────────────────────────────────────────────────

type ClientWriter = Arc<Mutex<UnixStream>>;

fn send(writer: &ClientWriter, message: &Value) -> bool {
    let mut line = message.to_string();
    line.push('\n');
    lock(writer).write_all(line.as_bytes()).is_ok()
}

struct Output {
    history: VecDeque<String>,
    history_bytes: usize,
    modes: BTreeMap<u32, bool>,
    subscriber: Option<(u64, ClientWriter)>,
}

struct HostTerminal {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    pid: Option<u32>,
    size: Mutex<(u16, u16)>,
    output: Mutex<Output>,
}

struct Host {
    terminals: Mutex<HashMap<String, Arc<HostTerminal>>>,
    clients: AtomicUsize,
    idle_since: Mutex<Instant>,
}

fn valid_key(key: &str) -> bool {
    (8..=128).contains(&key.len()) && key.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn text<'a>(request: &'a Value, field: &str) -> Result<&'a str, String> {
    request.get(field).and_then(Value::as_str).ok_or_else(|| format!("missing {field}"))
}

fn dimension(request: &Value, field: &str) -> u16 {
    request.get(field).and_then(Value::as_u64).map_or(1, |value| value.clamp(1, 2000) as u16)
}

impl Host {
    fn terminal(&self, request: &Value) -> Result<Arc<HostTerminal>, String> {
        let key = text(request, "key")?;
        lock(&self.terminals).get(key).cloned().ok_or_else(|| "no such terminal".to_string())
    }

    fn spawn(self: &Arc<Self>, request: &Value, client: (u64, ClientWriter)) -> Result<Value, String> {
        let key = text(request, "key")?.to_string();
        if !valid_key(&key) {
            return Err("invalid terminal key".into());
        }
        let cwd = text(request, "cwd")?.to_string();
        let (cols, rows) = (dimension(request, "cols"), dimension(request, "rows"));
        let mut terminals = lock(&self.terminals);
        if terminals.contains_key(&key) {
            return Err("terminal key already in use".into());
        }
        if terminals.len() >= MAX_TERMINALS {
            return Err("Terminal capacity reached. Close a pane before opening another.".into());
        }
        let pair = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|error| format!("openpty failed: {error}"))?;
        let writer = pair.master.take_writer().map_err(|error| error.to_string())?;
        let mut reader = pair.master.try_clone_reader().map_err(|error| error.to_string())?;
        let mut command = CommandBuilder::new("zsh");
        command.arg("-il");
        command.cwd(&cwd);
        crate::pty::configure_pane_command(&mut command, pair.master.as_ref());
        let child = pair.slave.spawn_command(command).map_err(|error| format!("spawn failed: {error}"))?;
        let pid = child.process_id();
        drop(pair.slave);
        let terminal = Arc::new(HostTerminal {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            pid,
            size: Mutex::new((cols, rows)),
            output: Mutex::new(Output { history: VecDeque::new(), history_bytes: 0, modes: BTreeMap::new(), subscriber: Some(client) }),
        });
        terminals.insert(key.clone(), terminal.clone());
        drop(terminals);

        let host = self.clone();
        std::thread::spawn(move || {
            let mut decoder = crate::pty::Utf8Stream::default();
            let mut buffer = [0u8; 16384];
            loop {
                let data = match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => decoder.push(&buffer[..count]),
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                };
                if !data.is_empty() {
                    terminal.record(&key, data);
                }
            }
            let tail = decoder.finish();
            if !tail.is_empty() {
                terminal.record(&key, tail);
            }
            // Gone for good: an exited shell is not kept for a later attach.
            lock(&host.terminals).remove(&key);
            if let Some((_, writer)) = lock(&terminal.output).subscriber.take() {
                send(&writer, &json!({ "event": "exit", "key": key }));
            }
            let _ = lock(&terminal.child).wait();
            host.touch();
        });
        Ok(json!({ "pid": pid }))
    }

    fn attach(&self, request: &Value, client: (u64, ClientWriter)) -> Result<Value, String> {
        let key = text(request, "key")?;
        let terminal = self.terminal(request)?;
        {
            // Held across the replay so no output is lost or delivered twice.
            let mut output = lock(&terminal.output);
            if let Some((previous, writer)) = output.subscriber.take() {
                if previous != client.0 {
                    send(&writer, &json!({ "event": "taken", "key": key }));
                }
            }
            let mut replay: String = output.history.iter().map(String::as_str).collect();
            replay.push_str(&restate_modes(&output.modes));
            send(&client.1, &json!({ "event": "data", "key": key, "data": replay, "replay": true }));
            output.subscriber = Some(client);
        }
        let (cols, rows) = *lock(&terminal.size);
        Ok(json!({ "pid": terminal.pid, "cols": cols, "rows": rows }))
    }

    fn handle(self: &Arc<Self>, request: &Value, client: (u64, ClientWriter)) -> Result<Value, String> {
        match text(request, "op")? {
            "hello" => Ok(json!({ "protocol": PROTOCOL, "pid": std::process::id(), "version": env!("CARGO_PKG_VERSION") })),
            "spawn" => self.spawn(request, client),
            "attach" => self.attach(request, client),
            "alive" => {
                let terminals = lock(&self.terminals);
                let keys: Vec<&str> = request
                    .get("keys")
                    .and_then(Value::as_array)
                    .map(|keys| keys.iter().filter_map(Value::as_str).filter(|key| terminals.contains_key(*key)).collect())
                    .unwrap_or_default();
                Ok(json!(keys))
            }
            "write" => {
                let terminal = self.terminal(request)?;
                let mut writer = lock(&terminal.writer);
                writer.write_all(text(request, "data")?.as_bytes()).map_err(|error| error.to_string())?;
                writer.flush().map_err(|error| error.to_string())?;
                Ok(Value::Null)
            }
            "resize" => {
                let terminal = self.terminal(request)?;
                let (cols, rows) = (dimension(request, "cols"), dimension(request, "rows"));
                let unchanged = *lock(&terminal.size) == (cols, rows);
                lock(&terminal.master)
                    .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
                    .map_err(|error| error.to_string())?;
                *lock(&terminal.size) = (cols, rows);
                // A program redraws on a size change. After an attach the size
                // is often the same, and it still has to redraw for the new view.
                if unchanged && request.get("redraw").and_then(Value::as_bool) == Some(true) {
                    if let Some(group) = lock(&terminal.master).process_group_leader() {
                        // SAFETY: signalling a process group we started; a stale id only fails.
                        unsafe { libc::killpg(group, libc::SIGWINCH) };
                    }
                }
                Ok(Value::Null)
            }
            "snapshot" => {
                let terminal = self.terminal(request)?;
                let (cols, rows) = *lock(&terminal.size);
                Ok(json!({ "pid": terminal.pid, "cols": cols, "rows": rows }))
            }
            "foreground" => {
                let terminal = self.terminal(request)?;
                let want_session = request.get("wantSession").and_then(Value::as_bool) == Some(true);
                let (cli, session_id) = crate::pty::foreground_of(lock(&terminal.master).as_ref(), want_session);
                Ok(json!({ "cli": cli, "sessionId": session_id }))
            }
            "kill" => {
                if let Some(terminal) = lock(&self.terminals).remove(text(request, "key")?) {
                    let mut child = lock(&terminal.child);
                    let _ = child.kill();
                }
                self.touch();
                Ok(Value::Null)
            }
            other => Err(format!("unknown operation {other}")),
        }
    }

    fn touch(&self) {
        *lock(&self.idle_since) = Instant::now();
    }

    fn idle(&self) -> bool {
        self.clients.load(Ordering::SeqCst) == 0 && lock(&self.terminals).is_empty() && lock(&self.idle_since).elapsed() >= IDLE_EXIT
    }
}

impl HostTerminal {
    fn record(&self, key: &str, data: String) {
        let mut output = lock(&self.output);
        track_modes(&mut output.modes, &data);
        if let Some((_, writer)) = &output.subscriber {
            if !send(writer, &json!({ "event": "data", "key": key, "data": data })) {
                output.subscriber = None;
            }
        }
        output.history_bytes += data.len();
        output.history.push_back(data);
        while output.history_bytes > HISTORY_BYTES && output.history.len() > 1 {
            if let Some(dropped) = output.history.pop_front() {
                output.history_bytes -= dropped.len();
            }
        }
    }
}

fn serve_client(host: Arc<Host>, stream: UnixStream, client_id: u64) {
    let Ok(read_half) = stream.try_clone() else { return };
    let writer: ClientWriter = Arc::new(Mutex::new(stream));
    host.clients.fetch_add(1, Ordering::SeqCst);
    for line in BufReader::new(read_half).lines() {
        let Ok(line) = line else { break };
        let Ok(request) = serde_json::from_str::<Value>(&line) else { continue };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let response = match host.handle(&request, (client_id, writer.clone())) {
            Ok(result) => json!({ "id": id, "ok": true, "result": result }),
            Err(error) => json!({ "id": id, "ok": false, "error": error }),
        };
        if !send(&writer, &response) {
            break;
        }
    }
    // The app went away. Its terminals keep running and keep their history.
    for terminal in lock(&host.terminals).values() {
        let mut output = lock(&terminal.output);
        if output.subscriber.as_ref().is_some_and(|(id, _)| *id == client_id) {
            output.subscriber = None;
        }
    }
    host.clients.fetch_sub(1, Ordering::SeqCst);
    host.touch();
}

/// Run the host until it has been idle for a while. Never returns normally.
pub fn run_host(socket: &Path) -> ! {
    // Detach from whatever started us: its exit must not take the shells along.
    // SAFETY: plain libc calls with no pointers.
    unsafe {
        libc::setsid();
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    let _ = std::fs::remove_file(socket);
    let listener = match UnixListener::bind(socket) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("[pty-host] bind {}: {error}", socket.display());
            std::process::exit(1);
        }
    };
    let _ = std::fs::set_permissions(socket, std::os::unix::fs::PermissionsExt::from_mode(0o600));
    let host = Arc::new(Host { terminals: Mutex::new(HashMap::new()), clients: AtomicUsize::new(0), idle_since: Mutex::new(Instant::now()) });
    {
        let host = host.clone();
        let socket = socket.to_path_buf();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(2));
            if host.idle() {
                let _ = std::fs::remove_file(&socket);
                std::process::exit(0);
            }
        });
    }
    let mut next_client = 1u64;
    for stream in listener.incoming().flatten() {
        let host = host.clone();
        let client_id = next_client;
        next_client += 1;
        std::thread::spawn(move || serve_client(host, stream, client_id));
    }
    std::process::exit(0)
}

// ── client (inside the app) ─────────────────────────────────────────────────

pub enum HostEvent {
    Data { data: String, replay: bool },
    Exit,
    Taken,
}
type Sink = Box<dyn Fn(HostEvent) + Send + Sync>;

pub struct HostClient {
    writer: Mutex<UnixStream>,
    next_request: AtomicU64,
    pending: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    sinks: Mutex<HashMap<String, Sink>>,
}

impl HostClient {
    fn connect(socket: &Path) -> std::io::Result<Arc<Self>> {
        let stream = UnixStream::connect(socket)?;
        let reader = stream.try_clone()?;
        let client = Arc::new(Self {
            writer: Mutex::new(stream),
            next_request: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            sinks: Mutex::new(HashMap::new()),
        });
        let dispatch = client.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(reader).lines() {
                let Ok(line) = line else { break };
                let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                dispatch.dispatch(message);
            }
            // The host is gone: every terminal it held has ended, and nobody is answering.
            lock(&dispatch.pending).clear();
            for (_, sink) in lock(&dispatch.sinks).drain() {
                sink(HostEvent::Exit);
            }
        });
        Ok(client)
    }

    fn dispatch(&self, mut message: Value) {
        if let Some(event) = message.get("event").and_then(Value::as_str).map(str::to_string) {
            let Some(key) = message.get("key").and_then(Value::as_str).map(str::to_string) else { return };
            let ended = event != "data";
            let sinks = lock(&self.sinks);
            if let Some(sink) = sinks.get(&key) {
                sink(match event.as_str() {
                    "data" => HostEvent::Data {
                        replay: message.get("replay").and_then(Value::as_bool) == Some(true),
                        data: match message.get_mut("data").map(Value::take) {
                            Some(Value::String(data)) => data,
                            _ => String::new(),
                        },
                    },
                    "taken" => HostEvent::Taken,
                    _ => HostEvent::Exit,
                });
            }
            drop(sinks);
            if ended {
                lock(&self.sinks).remove(&key);
            }
            return;
        }
        let Some(id) = message.get("id").and_then(Value::as_u64) else { return };
        if let Some(reply) = lock(&self.pending).remove(&id) {
            let _ = reply.send(if message.get("ok").and_then(Value::as_bool) == Some(true) {
                Ok(message.get_mut("result").map(Value::take).unwrap_or(Value::Null))
            } else {
                Err(message.get("error").and_then(Value::as_str).unwrap_or("terminal host error").to_string())
            });
        }
    }

    /// Send one request and wait for its answer. Call from a blocking context.
    pub fn request(&self, mut request: Value) -> Result<Value, String> {
        let id = self.next_request.fetch_add(1, Ordering::SeqCst);
        request["id"] = json!(id);
        let (reply, answer) = mpsc::channel();
        lock(&self.pending).insert(id, reply);
        let mut line = request.to_string();
        line.push('\n');
        if let Err(error) = lock(&self.writer).write_all(line.as_bytes()) {
            lock(&self.pending).remove(&id);
            return Err(format!("terminal host is not reachable: {error}"));
        }
        answer.recv_timeout(REQUEST_TIMEOUT).unwrap_or_else(|_| {
            lock(&self.pending).remove(&id);
            Err("terminal host did not answer".into())
        })
    }

    /// Route a terminal's events. Register before `spawn` or `attach`.
    pub fn listen(&self, key: &str, sink: Sink) {
        lock(&self.sinks).insert(key.to_string(), sink);
    }

    pub fn forget(&self, key: &str) {
        lock(&self.sinks).remove(key);
    }
}

/// Start the host process: this executable in host mode, detached.
fn start_host(socket: &Path) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    std::process::Command::new(executable)
        .arg(HOST_FLAG)
        .arg(socket)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not start the terminal host: {error}"))
}

/// Connect to the host at `socket`, starting one when none answers.
pub fn connect_or_start(socket: &Path, start: impl Fn(&Path) -> Result<(), String>) -> Result<Arc<HostClient>, String> {
    let hello = |client: Arc<HostClient>| -> Result<Arc<HostClient>, String> {
        let answer = client.request(json!({ "op": "hello" }))?;
        match answer.get("protocol").and_then(Value::as_u64) {
            Some(PROTOCOL) => Ok(client),
            other => Err(format!("terminal host speaks protocol {other:?}, expected {PROTOCOL}")),
        }
    };
    if let Ok(client) = HostClient::connect(socket) {
        return hello(client);
    }
    start(socket)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match HostClient::connect(socket) {
            Ok(client) => return hello(client),
            Err(error) if Instant::now() >= deadline => return Err(format!("terminal host did not start: {error}")),
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// Where the host listens. Unix socket paths are short, so the app-data
/// folder is used only when it fits; otherwise a private folder under /tmp.
pub fn socket_path(app_data: &Path) -> PathBuf {
    let name = if cfg!(debug_assertions) { "pty-host-dev.sock" } else { "pty-host.sock" };
    let preferred = app_data.join(name);
    if preferred.as_os_str().len() < 100 {
        return preferred;
    }
    // SAFETY: getuid has no failure mode.
    let dir = PathBuf::from(format!("/tmp/beads-station-{}", unsafe { libc::getuid() }));
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::set_permissions(&dir, std::os::unix::fs::PermissionsExt::from_mode(0o700));
    dir.join(name)
}

static CLIENT: Mutex<Option<Arc<HostClient>>> = Mutex::new(None);

/// The app's connection to the host, made (and the host started) on first use.
pub fn client(app_data: &Path) -> Result<Arc<HostClient>, String> {
    let mut slot = lock(&CLIENT);
    if let Some(client) = slot.as_ref() {
        // A dead connection answers nothing; replace it.
        if client.request(json!({ "op": "alive", "keys": [] })).is_ok() {
            return Ok(client.clone());
        }
    }
    std::fs::create_dir_all(app_data).map_err(|error| error.to_string())?;
    let client = connect_or_start(&socket_path(app_data), start_host)?;
    *slot = Some(client.clone());
    Ok(client)
}

/// The existing connection, if there is one. Never starts a host.
pub fn existing_client(app_data: &Path) -> Option<Arc<HostClient>> {
    if let Some(client) = lock(&CLIENT).as_ref() {
        return Some(client.clone());
    }
    let client = HostClient::connect(&socket_path(app_data)).ok()?;
    *lock(&CLIENT) = Some(client.clone());
    Some(client)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_and_restates_screen_and_mouse_modes() {
        let mut modes = BTreeMap::new();
        track_modes(&mut modes, "hello\u{1b}[?1049h\u{1b}[?1000;1006h\u{1b}[?25l text \u{1b}[?2004h");
        assert_eq!(restate_modes(&modes), "\u{1b}[?25l\u{1b}[?1000h\u{1b}[?1006h\u{1b}[?1049h\u{1b}[?2004h");
        track_modes(&mut modes, "\u{1b}[?1049l\u{1b}[?25h\u{1b}[?1000l\u{1b}[?1006l\u{1b}[?2004l\u{1b}[?9999h");
        assert_eq!(restate_modes(&modes), "");
        // An unfinished sequence at the end of a read is ignored, not misread.
        track_modes(&mut modes, "\u{1b}[?10");
        assert_eq!(restate_modes(&modes), "");
    }

    #[test]
    fn keys_are_opaque_tokens() {
        assert!(valid_key("2c975569-13c1-43b2-8e7a-f88d6138d7d8"));
        assert!(!valid_key("short"));
        assert!(!valid_key("../../../../etc/passwd"));
    }

    /// An in-process host on a private socket, as the real one behaves.
    fn test_host(name: &str) -> PathBuf {
        let socket = PathBuf::from(format!("/tmp/bs-pty-host-{name}-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&socket);
        let listener = UnixListener::bind(&socket).unwrap();
        let host = Arc::new(Host { terminals: Mutex::new(HashMap::new()), clients: AtomicUsize::new(0), idle_since: Mutex::new(Instant::now()) });
        std::thread::spawn(move || {
            let mut next = 1;
            for stream in listener.incoming().flatten() {
                let host = host.clone();
                let id = next;
                next += 1;
                std::thread::spawn(move || serve_client(host, stream, id));
            }
        });
        socket
    }

    fn collect(client: &HostClient, key: &str) -> (Arc<Mutex<String>>, Arc<Mutex<Vec<&'static str>>>) {
        let output = Arc::new(Mutex::new(String::new()));
        let ended = Arc::new(Mutex::new(Vec::new()));
        let (sink_output, sink_ended) = (output.clone(), ended.clone());
        client.listen(key, Box::new(move |event| match event {
            HostEvent::Data { data, replay } => {
                let mut output = lock(&sink_output);
                if replay {
                    output.push_str("<replay>");
                }
                output.push_str(&data);
            }
            HostEvent::Exit => lock(&sink_ended).push("exit"),
            HostEvent::Taken => lock(&sink_ended).push("taken"),
        }));
        (output, ended)
    }

    fn wait_until(what: &str, check: impl Fn() -> bool) {
        for _ in 0..200 {
            if check() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("timed out waiting for {what}");
    }

    const KEY: &str = "test-terminal-0001";

    #[test]
    fn a_shell_outlives_its_client_and_replays_to_the_next_one() {
        let socket = test_host("survive");
        let first = connect_or_start(&socket, |_| Err("no host".into())).unwrap();
        let (output, _) = collect(&first, KEY);
        let pid = first.request(json!({ "op": "spawn", "key": KEY, "cwd": "/tmp", "cols": 80, "rows": 24 })).unwrap()["pid"].as_u64().unwrap();
        first.request(json!({ "op": "write", "key": KEY, "data": "export BS_MARK=kept; echo first-$BS_MARK\r" })).unwrap();
        wait_until("first output", || lock(&output).contains("first-kept"));
        assert!(first.request(json!({ "op": "spawn", "key": KEY, "cwd": "/tmp" })).is_err(), "a key names one shell only");

        // The app quits: its connection closes, nothing else is said.
        lock(&first.writer).shutdown(std::net::Shutdown::Both).unwrap();
        drop(first);
        std::thread::sleep(Duration::from_millis(200));

        let second = connect_or_start(&socket, |_| Err("no host".into())).unwrap();
        assert_eq!(second.request(json!({ "op": "alive", "keys": [KEY, "unknown-key-0000"] })).unwrap(), json!([KEY]));
        let (output, ended) = collect(&second, KEY);
        let attached = second.request(json!({ "op": "attach", "key": KEY })).unwrap();
        assert_eq!(attached["pid"].as_u64(), Some(pid), "the same process, not a new shell");
        assert!(lock(&output).starts_with("<replay>"));
        assert!(lock(&output).contains("first-kept"), "history is replayed");

        // Same shell state, and live output after the replay is not marked as replay.
        second.request(json!({ "op": "write", "key": KEY, "data": "echo second-$BS_MARK\r" })).unwrap();
        wait_until("output after attach", || lock(&output).contains("second-kept"));
        assert_eq!(lock(&output).matches("<replay>").count(), 1);
        second.request(json!({ "op": "resize", "key": KEY, "cols": 100, "rows": 30, "redraw": true })).unwrap();
        assert_eq!(second.request(json!({ "op": "snapshot", "key": KEY })).unwrap()["cols"], 100);

        second.request(json!({ "op": "kill", "key": KEY })).unwrap();
        wait_until("exit event", || lock(&ended).contains(&"exit"));
        assert_eq!(second.request(json!({ "op": "alive", "keys": [KEY] })).unwrap(), json!([]));
        assert!(second.request(json!({ "op": "attach", "key": KEY })).is_err(), "a dead shell is never attached");
        let _ = std::fs::remove_file(socket);
    }

    #[test]
    fn a_second_attach_takes_the_terminal_and_tells_the_first() {
        let socket = test_host("taken");
        let key = "test-terminal-0002";
        let first = connect_or_start(&socket, |_| Err("no host".into())).unwrap();
        let (_, first_ended) = collect(&first, key);
        first.request(json!({ "op": "spawn", "key": key, "cwd": "/tmp", "cols": 80, "rows": 24 })).unwrap();
        let second = connect_or_start(&socket, |_| Err("no host".into())).unwrap();
        let (output, _) = collect(&second, key);
        second.request(json!({ "op": "attach", "key": key })).unwrap();
        wait_until("taken event", || lock(&first_ended).contains(&"taken"));
        second.request(json!({ "op": "write", "key": key, "data": "echo only-second\r" })).unwrap();
        wait_until("second sees output", || lock(&output).contains("only-second"));
        second.request(json!({ "op": "kill", "key": key })).unwrap();
        let _ = std::fs::remove_file(socket);
    }

    #[test]
    fn connecting_starts_a_host_only_when_none_answers() {
        let socket = PathBuf::from(format!("/tmp/bs-pty-host-start-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&socket);
        let started = Arc::new(AtomicUsize::new(0));
        let counter = started.clone();
        let start = move |socket: &Path| {
            counter.fetch_add(1, Ordering::SeqCst);
            let listener = UnixListener::bind(socket).map_err(|error| error.to_string())?;
            let host = Arc::new(Host { terminals: Mutex::new(HashMap::new()), clients: AtomicUsize::new(0), idle_since: Mutex::new(Instant::now()) });
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let host = host.clone();
                    std::thread::spawn(move || serve_client(host, stream, 1));
                }
            });
            Ok(())
        };
        connect_or_start(&socket, &start).unwrap();
        connect_or_start(&socket, &start).unwrap();
        assert_eq!(started.load(Ordering::SeqCst), 1);
        assert!(socket_path(Path::new("/short")).starts_with("/short"));
        assert!(socket_path(Path::new(&format!("/{}", "x".repeat(120)))).to_string_lossy().starts_with("/tmp/beads-station-"));
        let _ = std::fs::remove_file(socket);
    }
}
