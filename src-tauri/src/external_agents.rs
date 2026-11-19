// Agent CLIs running in terminals outside Beads Station (Code-7xc.4).
//
// macOS does not let one app take over another app's live PTY, so "bring this
// terminal in" means: find the agent, read its folder and exact conversation,
// stop it after the user's confirm, and let the frontend resume the same
// conversation in a split. Everything here is read-only except
// `external_agent_stop`, which only ever signals a process this module just
// classified as an agent CLI owned by the current user, never with SIGKILL.
//
// No AppleScript, no Accessibility or Automation prompts: only the process
// table (sysinfo, `ps`), `lsof` on the user's own process and, when it is on
// the machine, `tmux list-panes`.

use crate::pty::classify_agent_cli;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// One process, with what classification needs. Built from the process table
/// in production and by hand in tests.
#[derive(Clone, Debug, Default)]
pub(crate) struct Proc {
    pub pid: u32,
    pub parent: Option<u32>,
    /// Full command line (argv[0] is the program path or title).
    pub argv: Vec<String>,
    pub uid: Option<u32>,
    pub tty: Option<String>,
    pub cwd: Option<String>,
    /// The process environment carries `BEADS_STATION_PANE=1`: a shell this app started.
    pub marked_ours: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Found {
    pub pid: u32,
    pub cli: &'static str,
    pub app: Option<&'static str>,
    /// Pids from the agent up to the root, the agent first.
    pub chain: Vec<u32>,
    pub in_tmux: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgent {
    pub pid: u32,
    pub cli: String,
    pub cwd: Option<String>,
    pub tty: Option<String>,
    /// "Terminal", "iTerm2", "Ghostty", "WezTerm", "kitty", "Alacritty", "VS Code" or "Warp".
    pub app: Option<String>,
    pub tmux_session: Option<String>,
    pub session_id: Option<String>,
}

/// The terminal application named by a process's program path.
pub(crate) fn terminal_app_name(program: &str) -> Option<&'static str> {
    let lower = program.to_ascii_lowercase();
    let in_bundle = |name: &str| lower.contains(&format!("/{name}.app/"));
    let base = lower.rsplit('/').next().unwrap_or(&lower);
    if in_bundle("terminal") { Some("Terminal") }
    else if in_bundle("iterm") || in_bundle("iterm2") || base == "iterm2" { Some("iTerm2") }
    else if in_bundle("ghostty") || base == "ghostty" { Some("Ghostty") }
    else if in_bundle("wezterm") || base.starts_with("wezterm") { Some("WezTerm") }
    else if in_bundle("kitty") || base == "kitty" { Some("kitty") }
    else if in_bundle("alacritty") || base == "alacritty" { Some("Alacritty") }
    else if in_bundle("warp") { Some("Warp") }
    else if in_bundle("visual studio code") || in_bundle("code") || in_bundle("cursor") { Some("VS Code") }
    else { None }
}

fn is_tmux(argv: &[String]) -> bool {
    argv.first().is_some_and(|program| {
        let name = program.rsplit('/').next().unwrap_or(program);
        name == "tmux" || name.starts_with("tmux:")
    })
}

fn is_pty_host(argv: &[String]) -> bool {
    argv.iter().any(|arg| arg == "--pty-host")
}

/// Agents that run outside this app. `own_pid` is Beads Station itself: its
/// in-process PTYs are its children, and the detached terminal host (and the
/// shells it owns) carry `--pty-host` or the pane marker. Nested matches (an
/// agent's own helper processes) are dropped: the shallowest agent wins.
pub(crate) fn find_external(procs: &[Proc], own_pid: u32, uid: u32) -> Vec<Found> {
    let by_pid: HashMap<u32, &Proc> = procs.iter().map(|proc| (proc.pid, proc)).collect();
    // Ancestors, nearest first; cycle- and depth-safe.
    let chain_of = |start: u32| -> Vec<u32> {
        let mut chain = vec![start];
        let mut seen = HashSet::from([start]);
        let mut current = start;
        while let Some(parent) = by_pid.get(&current).and_then(|proc| proc.parent) {
            if parent == 0 || !seen.insert(parent) || chain.len() > 64 { break }
            chain.push(parent);
            current = parent;
        }
        chain
    };
    let agents: HashMap<u32, &'static str> = procs
        .iter()
        .filter(|proc| proc.uid == Some(uid))
        .filter_map(|proc| classify_agent_cli(&proc.argv.iter().take(2).cloned().collect::<Vec<_>>()).map(|cli| (proc.pid, cli)))
        .collect();
    let mut found = Vec::new();
    for (&pid, &cli) in &agents {
        let proc = by_pid[&pid];
        if proc.marked_ours || pid == own_pid { continue }
        let chain = chain_of(pid);
        let above = &chain[1..];
        // Our own shells, the terminal host, or an agent nested in another agent.
        if above.iter().any(|ancestor| {
            *ancestor == own_pid
                || agents.contains_key(ancestor)
                || by_pid.get(ancestor).is_some_and(|p| p.marked_ours || is_pty_host(&p.argv))
        }) {
            continue;
        }
        let in_tmux = above.iter().any(|ancestor| by_pid.get(ancestor).is_some_and(|p| is_tmux(&p.argv)));
        let app = above.iter().find_map(|ancestor| by_pid.get(ancestor).and_then(|p| p.argv.first()).and_then(|program| terminal_app_name(program)));
        found.push(Found { pid, cli, app, chain, in_tmux });
    }
    found.sort_by_key(|entry| entry.pid);
    found
}

/// The tmux session whose pane holds the agent: the pane's shell is in the
/// agent's ancestry, or (fallback) the pane's tty is the agent's. The listing
/// is `#{pane_pid}\t#{session_name}\t#{pane_tty}` per line.
pub(crate) fn tmux_session_for(chain: &[u32], tty: Option<&str>, listing: &str) -> Option<String> {
    let rows: Vec<(u32, &str, &str)> = listing
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            Some((parts.next()?.trim().parse().ok()?, parts.next()?, parts.next().unwrap_or("")))
        })
        .collect();
    rows.iter()
        .find(|(pane_pid, ..)| chain.contains(pane_pid))
        .or_else(|| tty.and_then(|tty| rows.iter().find(|(_, _, pane_tty)| !pane_tty.is_empty() && pane_tty.trim_start_matches("/dev/") == tty.trim_start_matches("/dev/"))))
        .map(|(_, name, _)| name.to_string())
}

/// A stop may only target a pid the listing just produced.
pub(crate) fn stop_target(pid: u32, listing: &[Found]) -> Result<&Found, String> {
    listing
        .iter()
        .find(|entry| entry.pid == pid)
        .ok_or_else(|| "That process is not an agent CLI running outside Beads Station (it may have already quit).".to_string())
}

// ---- process table (unix) -------------------------------------------------

#[cfg(unix)]
fn ps_table() -> HashMap<u32, (u32, String)> {
    // pid, uid, tty. One cheap call; sysinfo (without the `user` feature) has no uid.
    let output = std::process::Command::new("/bin/ps").args(["-axo", "pid=,uid=,tty="]).stderr(std::process::Stdio::null()).output();
    let mut table = HashMap::new();
    if let Ok(output) = output {
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let mut parts = line.split_whitespace();
            if let (Some(pid), Some(uid)) = (parts.next().and_then(|v| v.parse::<u32>().ok()), parts.next().and_then(|v| v.parse::<u32>().ok())) {
                table.insert(pid, (uid, parts.next().unwrap_or("").to_string()));
            }
        }
    }
    table
}

#[cfg(unix)]
fn read_procs() -> (Vec<Proc>, u32) {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let uid = unsafe { libc::getuid() };
    let ps = ps_table();
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cmd(UpdateKind::OnlyIfNotSet));
    let procs = system
        .processes()
        .iter()
        .map(|(pid, process)| {
            let pid = pid.as_u32();
            let (proc_uid, tty) = match ps.get(&pid) {
                Some((uid, tty)) => (Some(*uid), Some(tty.clone()).filter(|tty| !tty.is_empty() && tty != "??")),
                None => (None, None),
            };
            Proc {
                pid,
                parent: process.parent().map(|parent| parent.as_u32()),
                argv: process.cmd().iter().map(|arg| arg.to_string_lossy().into_owned()).collect(),
                uid: proc_uid,
                tty,
                cwd: None,
                marked_ours: false,
            }
        })
        .collect();
    (procs, uid)
}

/// Folder and "started by this app" marker for the few candidate processes.
#[cfg(unix)]
fn enrich(procs: &mut [Proc], pids: &[u32]) {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let ids: Vec<Pid> = pids.iter().map(|pid| Pid::from_u32(*pid)).collect();
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&ids),
        true,
        ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always).with_environ(UpdateKind::Always),
    );
    for proc in procs.iter_mut().filter(|proc| pids.contains(&proc.pid)) {
        if let Some(process) = system.process(Pid::from_u32(proc.pid)) {
            proc.cwd = process.cwd().map(|cwd| cwd.to_string_lossy().into_owned());
            proc.marked_ours = process.environ().iter().any(|entry| entry.to_string_lossy() == "BEADS_STATION_PANE=1");
        }
    }
}

#[cfg(unix)]
fn tmux_listing() -> Option<String> {
    let path = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].into_iter().find(|path| std::path::Path::new(path).is_file())?;
    let output = std::process::Command::new(path)
        .args(["list-panes", "-a", "-F", "#{pane_pid}\t#{session_name}\t#{pane_tty}"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(unix)]
fn session_for(cli: &str, pid: u32, cwd: Option<&str>) -> Option<String> {
    match cli {
        "claude" => crate::pty::claude_session_id(i32::try_from(pid).ok()?),
        "codex" => {
            let group = unsafe { libc::getpgid(pid as libc::pid_t) };
            (group > 0).then(|| crate::pty::codex_session_id(group)).flatten()
        }
        "gemini" => {
            let home = std::path::PathBuf::from(std::env::var_os("HOME")?).join(".gemini");
            crate::session_usage::gemini_usage(&home, cwd.filter(|cwd| cwd.starts_with('/'))?, None)?.session_id
        }
        _ => None,
    }
}

#[cfg(unix)]
fn list_external() -> (Vec<Found>, Vec<Proc>) {
    let (mut procs, uid) = read_procs();
    let mut found = find_external(&procs, std::process::id(), uid);
    let pids: Vec<u32> = found.iter().map(|entry| entry.pid).collect();
    enrich(&mut procs, &pids);
    // The environment marker is only known now: drop shells this app started.
    found.retain(|entry| !procs.iter().any(|proc| proc.pid == entry.pid && proc.marked_ours));
    (found, procs)
}

/// Agent CLIs (Claude, Codex, Gemini) running outside this app, with their
/// folder, terminal app, tmux session and conversation when those can be read.
/// Reads the process table; starts and changes nothing.
#[tauri::command]
pub async fn external_agents() -> Result<Vec<ExternalAgent>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(unix)]
        {
            let (found, procs) = list_external();
            let tmux = found.iter().any(|entry| entry.in_tmux).then(tmux_listing).flatten();
            let mut agents: Vec<ExternalAgent> = found
                .into_iter()
                .take(64)
                .map(|entry| {
                    let proc = procs.iter().find(|proc| proc.pid == entry.pid);
                    let cwd = proc.and_then(|proc| proc.cwd.clone());
                    let tty = proc.and_then(|proc| proc.tty.clone());
                    let tmux_session = if entry.in_tmux { tmux.as_deref().and_then(|listing| tmux_session_for(&entry.chain, tty.as_deref(), listing)) } else { None };
                    ExternalAgent {
                        pid: entry.pid,
                        cli: entry.cli.to_string(),
                        session_id: session_for(entry.cli, entry.pid, cwd.as_deref()),
                        cwd,
                        tty,
                        app: entry.app.map(str::to_string),
                        tmux_session,
                    }
                })
                .collect();
            agents.sort_by(|a, b| a.cwd.cmp(&b.cwd).then(a.pid.cmp(&b.pid)));
            Ok(agents)
        }
        #[cfg(not(unix))]
        Ok(Vec::new())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    // ESRCH: gone. EPERM would mean someone else's process, which is also "not ours to wait on".
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(unix)]
fn wait_gone(pid: u32, millis: u64) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(millis);
    while std::time::Instant::now() < deadline {
        if !alive(pid) { return true }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    !alive(pid)
}

/// The session file an agent has been writing, if it can be named.
#[cfg(unix)]
fn session_file(cli: &str, id: Option<&str>) -> Option<std::path::PathBuf> {
    let (claude, _) = crate::transcripts::homes().ok()?;
    match (cli, id) {
        ("claude", Some(id)) => crate::session_usage::find_claude_session(&claude, id),
        _ => None,
    }
}

/// After the agent exits it flushes its last writes; wait (at most 2 s) until
/// the file stops growing so the resume sees the whole conversation.
#[cfg(unix)]
fn settle(path: Option<std::path::PathBuf>) {
    let Some(path) = path else {
        std::thread::sleep(std::time::Duration::from_millis(300));
        return;
    };
    let size = |path: &std::path::Path| std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    let mut last = size(&path);
    let mut stable = 0;
    while std::time::Instant::now() < deadline && stable < 2 {
        std::thread::sleep(std::time::Duration::from_millis(150));
        let now = size(&path);
        if now == last { stable += 1 } else { stable = 0; last = now }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopResult {
    pub exited: bool,
}

/// Stop an outside agent after the user's confirm: Ctrl-C (SIGINT), up to 2 s,
/// then SIGTERM, up to 3 s. Never SIGKILL. The pid must be one the listing
/// above returns right now, so a reused pid or a non-agent process is refused.
#[tauri::command]
pub async fn external_agent_stop(pid: u32) -> Result<StopResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(unix)]
        {
            let (found, _) = list_external();
            let target = stop_target(pid, &found)?.clone();
            let session = session_for(target.cli, pid, None);
            let file = session_file(target.cli, session.as_deref());
            let signal = |sig: libc::c_int| unsafe { libc::kill(pid as libc::pid_t, sig) };
            let exited = if signal(libc::SIGINT) == 0 {
                wait_gone(pid, 2000) || (signal(libc::SIGTERM) == 0 && wait_gone(pid, 3000))
            } else {
                !alive(pid)
            };
            if exited { settle(file) }
            Ok(StopResult { exited })
        }
        #[cfg(not(unix))]
        {
            let _ = pid;
            Err("Not supported on this platform".to_string())
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Whether a dropped path is a folder (a terminal's title-bar proxy icon drops its folder).
#[tauri::command]
pub fn external_path_is_dir(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: u32, parent: u32, argv: &[&str]) -> Proc {
        Proc { pid, parent: Some(parent), argv: argv.iter().map(|arg| arg.to_string()).collect(), uid: Some(501), ..Proc::default() }
    }

    const TERMINAL: &str = "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal";

    fn table() -> Vec<Proc> {
        vec![
            proc(1, 0, &["/sbin/launchd"]),
            // Beads Station and a shell it owns, running claude.
            proc(100, 1, &["/Applications/Beads Station.app/Contents/MacOS/beads-station"]),
            proc(101, 100, &["-zsh"]),
            proc(102, 101, &["claude"]),
            // The detached terminal host and its shell running codex.
            proc(110, 1, &["/Applications/Beads Station.app/Contents/MacOS/beads-station", "--pty-host", "/tmp/sock"]),
            proc(111, 110, &["-zsh"]),
            proc(112, 111, &["node", "/usr/local/lib/node_modules/@openai/codex/bin/codex.js"]),
            // Terminal.app -> login -> zsh -> claude (plus a helper below it).
            proc(200, 1, &[TERMINAL]),
            proc(201, 200, &["login", "-pf", "me"]),
            proc(202, 201, &["-zsh"]),
            proc(203, 202, &["claude"]),
            proc(204, 203, &["claude", "--mcp-helper"]),
            // tmux server with a pane shell running gemini.
            proc(300, 1, &["tmux: server"]),
            proc(301, 300, &["-zsh"]),
            proc(302, 301, &["node", "/opt/gemini-cli/bin/gemini"]),
            // Another user's claude.
            Proc { uid: Some(0), ..proc(400, 1, &["claude"]) },
        ]
    }

    #[test]
    fn our_own_shells_and_the_terminal_host_are_excluded() {
        let found = find_external(&table(), 100, 501);
        let pids: Vec<u32> = found.iter().map(|entry| entry.pid).collect();
        assert!(!pids.contains(&102), "a claude in our in-process PTY");
        assert!(!pids.contains(&112), "a codex in the pty host's shell");
        assert!(!pids.contains(&400), "another user's process");
    }

    #[test]
    fn a_terminal_app_agent_is_included_with_the_app_name_and_nested_helpers_are_not() {
        let found = find_external(&table(), 100, 501);
        let entry = found.iter().find(|entry| entry.pid == 203).expect("claude in Terminal");
        assert_eq!(entry.cli, "claude");
        assert_eq!(entry.app, Some("Terminal"));
        assert!(!entry.in_tmux);
        assert!(found.iter().all(|entry| entry.pid != 204));
    }

    #[test]
    fn the_pane_marker_excludes_a_shell_this_app_started() {
        let mut procs = table();
        procs.iter_mut().find(|proc| proc.pid == 203).unwrap().marked_ours = true;
        assert!(find_external(&procs, 100, 501).iter().all(|entry| entry.pid != 203));
    }

    #[test]
    fn tmux_ancestry_marks_the_agent_and_names_the_session() {
        let found = find_external(&table(), 100, 501);
        let entry = found.iter().find(|entry| entry.pid == 302).expect("gemini in tmux");
        assert_eq!(entry.cli, "gemini");
        assert!(entry.in_tmux);
        let listing = "301\twork api\t/dev/ttys004\n999\tother\t/dev/ttys009\n";
        assert_eq!(tmux_session_for(&entry.chain, None, listing).as_deref(), Some("work api"));
        // Fall back to the tty when the pane shell is not in the chain.
        assert_eq!(tmux_session_for(&[1], Some("ttys009"), listing).as_deref(), Some("other"));
        assert_eq!(tmux_session_for(&[1], Some("ttys777"), listing), None);
    }

    #[test]
    fn terminal_apps_are_named_from_their_program_path() {
        assert_eq!(terminal_app_name("/Applications/iTerm.app/Contents/MacOS/iTerm2"), Some("iTerm2"));
        assert_eq!(terminal_app_name("/Applications/Ghostty.app/Contents/MacOS/ghostty"), Some("Ghostty"));
        assert_eq!(terminal_app_name("/Applications/kitty.app/Contents/MacOS/kitty"), Some("kitty"));
        assert_eq!(terminal_app_name("/Applications/Visual Studio Code.app/Contents/MacOS/Electron"), Some("VS Code"));
        assert_eq!(terminal_app_name("-zsh"), None);
    }

    #[test]
    fn stop_refuses_unknown_and_non_agent_pids() {
        let found = find_external(&table(), 100, 501);
        assert!(stop_target(203, &found).is_ok());
        // A shell, our own agent, init, and a pid that does not exist.
        for pid in [202, 102, 1, 424242] {
            assert!(stop_target(pid, &found).is_err(), "pid {pid}");
        }
    }

    #[test]
    fn the_real_listing_runs_and_never_includes_this_test_process() {
        #[cfg(unix)]
        {
            let (found, _) = list_external();
            assert!(found.iter().all(|entry| entry.pid != std::process::id()));
        }
    }
}

/// Whether the Option key is held right now. A native file drop reports no
/// modifiers, so the page asks. Reads the global key state: no permission needed.
#[tauri::command]
pub fn external_option_held() -> bool {
    #[cfg(target_os = "macos")]
    {
        use objc2::runtime::AnyClass;
        use objc2::msg_send;
        const NS_EVENT_MODIFIER_OPTION: usize = 1 << 19;
        let flags: Option<usize> = objc2::exception::catch(std::panic::AssertUnwindSafe(|| unsafe {
            let class = AnyClass::get(c"NSEvent")?;
            Some(msg_send![class, modifierFlags])
        }))
        .ok()
        .flatten();
        flags.is_some_and(|flags| flags & NS_EVENT_MODIFIER_OPTION != 0)
    }
    #[cfg(not(target_os = "macos"))]
    false
}
