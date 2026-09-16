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
struct Utf8Stream {
    pending: Vec<u8>,
}
impl Utf8Stream {
    fn push(&mut self, bytes: &[u8]) -> String {
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
    fn finish(self) -> String {
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

#[tauri::command]
pub async fn pty_spawn(
    window: tauri::Window,
    cwd: String,
    event_key: String,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    if event_key.is_empty()
        || event_key.len() > 100
        || !event_key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Invalid terminal event key".into());
    }
    let permit = crate::spawngov::terminal_permit()?;
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
        configure_terminal_command(&mut cmd);
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
                                PtyDataPayload { id, data },
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
                    PtyDataPayload { id, data },
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
    let handle = handle(id)?;
    let (cols, rows) = *handle.size.lock().map_err(|e| e.to_string())?;
    Ok(PtySnapshot {
        id,
        pid: handle.pid,
        cols,
        rows,
    })
}

#[tauri::command]
pub async fn pty_kill(id: u32) -> Result<(), String> {
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

pub fn kill_all_ptys() -> usize {
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

pub fn active_pty_count() -> usize {
    PTYS.lock().unwrap_or_else(|e| e.into_inner()).len()
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
