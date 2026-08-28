// Beads Station — Phase 1
// PTY bridge: spawns native PTY pairs running `zsh -il`, streams output as
// Tauri events `pty_data:<id>`, accepts writes / resizes / kills via commands.

use once_cell::sync::Lazy;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

struct PtyHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

static PTYS: Lazy<Mutex<HashMap<u32, PtyHandle>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

#[derive(Clone, Serialize)]
struct PtyDataPayload {
    id: u32,
    data: String,
}

#[derive(Clone, Serialize)]
struct PtyExitPayload {
    id: u32,
}

#[tauri::command]
pub async fn pty_spawn(window: tauri::Window, cwd: String) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {}", e))?;

    let mut cmd = CommandBuilder::new("zsh");
    cmd.arg("-il");
    cmd.cwd(&cwd);
    cmd.env("LANG", "en_US.UTF-8");
    cmd.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn failed: {}", e))?;

    // Drop the slave; the child holds it.
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer failed: {}", e))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("try_clone_reader failed: {}", e))?;

    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);

    {
        let mut map = PTYS.lock().map_err(|e| format!("lock poisoned: {}", e))?;
        map.insert(
            id,
            PtyHandle {
                master: pair.master,
                writer,
                child,
            },
        );
    }

    // Reader task: blocking reads on a dedicated OS thread.
    let win_clone = window.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let s = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = win_clone.emit(
                        &format!("pty_data:{}", id),
                        PtyDataPayload { id, data: s },
                    );
                }
                Err(_) => break,
            }
        }
        // Emit exit once.
        let _ = win_clone.emit(&format!("pty_exit:{}", id), PtyExitPayload { id });
        // Best-effort: remove from map.
        if let Ok(mut map) = PTYS.lock() {
            map.remove(&id);
        }
    });

    let _ = window.app_handle();
    Ok(id)
}

#[tauri::command]
pub async fn pty_write(id: u32, data: String) -> Result<(), String> {
    let mut map = PTYS.lock().map_err(|e| format!("lock poisoned: {}", e))?;
    let handle = map
        .get_mut(&id)
        .ok_or_else(|| format!("no pty with id {}", id))?;
    handle
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write failed: {}", e))?;
    handle
        .writer
        .flush()
        .map_err(|e| format!("flush failed: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn pty_resize(id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let map = PTYS.lock().map_err(|e| format!("lock poisoned: {}", e))?;
    let handle = map
        .get(&id)
        .ok_or_else(|| format!("no pty with id {}", id))?;
    handle
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize failed: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn pty_kill(id: u32) -> Result<(), String> {
    let mut map = PTYS.lock().map_err(|e| format!("lock poisoned: {}", e))?;
    if let Some(mut handle) = map.remove(&id) {
        let _ = handle.child.kill();
    }
    Ok(())
}

/// EXP backbone: reap every live PTY child on app exit. A pane closed without
/// its FE unmount calling `pty_kill` (a crash, a force-quit, a missed cleanup)
/// otherwise leaks the master fd + child + reader thread for the process
/// lifetime — an fd-drain vector. Mirrors `claude::kill_all_sessions`; called
/// from the `CloseRequested` handler alongside it. Returns the count reaped.
pub fn kill_all_ptys() -> usize {
    let mut map = match PTYS.lock() {
        Ok(m) => m,
        Err(poisoned) => poisoned.into_inner(),
    };
    let n = map.len();
    for (_id, mut handle) in map.drain() {
        let _ = handle.child.kill();
    }
    n
}
