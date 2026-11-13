// Beads Station — Phase 3 file watcher.
//
// Watches `<repo_path>/.beads/` recursively via notify (FSEvents on
// macOS) so that when bd writes interactions.jsonl, export-state.json,
// or anything under embeddeddolt/, the frontend can re-fetch.
//
// Single-watcher design: bd has exactly one canonical DB per project,
// and Phase 3 has exactly one project root active at a time. We hold a
// global `Lazy<Mutex<Option<RecommendedWatcher>>>` so the watcher
// outlives this function call (dropping it stops the watch).
//
// Debouncing: macOS FSEvents already coalesces, but Dolt + bd hooks
// produce event bursts (e.g. write the jsonl, then update
// export-state.json a few ms later). We coalesce events within 250ms
// in a background tokio task before emitting the Tauri event. The
// frontend hook (useBdLive) debounces a second time at 100ms in case
// multiple sources fire close together.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::{Emitter, Window};
use tokio::sync::mpsc;

const DEBOUNCE_MS: u64 = 250;

/// RV3.6 — true for paths inside bd's embedded Dolt storage, which churns on
/// every read (noms/manifest, journal.idx, nbs_manifest_*). These must NOT
/// fire bd_changed or a read-triggered rewrite becomes an infinite refetch
/// loop. Matches any path component `embeddeddolt` or `.dolt` so it's robust
/// to the nested `<prefix>/.dolt/...` layout regardless of the repo prefix.
fn is_dolt_internal(p: &Path) -> bool {
    p.components().any(|c| {
        let s = c.as_os_str();
        s == "embeddeddolt" || s == ".dolt"
    })
}

/// Holds the active watcher for the lifetime of the app. Dropping the
/// `RecommendedWatcher` stops FSEvents delivery, so we keep it parked
/// in a `Lazy<Mutex<Option<_>>>`. The current repo path is tracked
/// alongside so a second watcher_start for the same path is a no-op.
struct WatcherState {
    // Held only to keep the watcher alive — dropping it stops FSEvents.
    #[allow(dead_code)]
    watcher: RecommendedWatcher,
    repo_path: String,
}

static WATCHER: Lazy<Mutex<Option<WatcherState>>> = Lazy::new(|| Mutex::new(None));

/// RV5.1 — separate slot for the Obsidian sensor watcher. Kept distinct from the
/// bd `WATCHER` so the two lifecycles are independent (the bd watcher is keyed
/// to the active repo; the sensor watcher tracks vault folders that don't move
/// with the repo). Holds all per-dir watchers alive for the app's lifetime.
static SENSE_WATCHER: Lazy<Mutex<Option<Vec<RecommendedWatcher>>>> =
    Lazy::new(|| Mutex::new(None));

#[derive(Serialize, Clone)]
struct BdChangedPayload {
    path: String,
    kind: &'static str,
}

/// Start watching `<repo_path>/.beads/` and emit
/// `bd_changed:{repo_path}` whenever a debounced event fires.
///
/// Idempotent: calling twice with the same `repo_path` is a no-op.
/// Calling with a different `repo_path` replaces the previous watcher.
#[tauri::command]
pub async fn watcher_start(window: Window, repo_path: String) -> Result<(), String> {
    let beads_dir: PathBuf = Path::new(&repo_path).join(".beads");
    if !beads_dir.exists() {
        return Err(format!(
            ".beads directory not found at {} — is this a bd-tracked repo?",
            beads_dir.display()
        ));
    }

    // Fast path: already watching this exact repo.
    {
        let guard = WATCHER.lock().map_err(|e| format!("watcher lock: {e}"))?;
        if let Some(state) = guard.as_ref() {
            if state.repo_path == repo_path {
                return Ok(());
            }
        }
    }

    // mpsc channel: notify's callback runs on a background thread and
    // shoves raw events into `tx`; the debouncer task reads from `rx`,
    // coalesces 250ms windows, and emits to the frontend.
    let (tx, mut rx) = mpsc::unbounded_channel::<PathBuf>();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            // First path is enough for the debouncer — we just need to
            // know *something* changed. The exact file isn't load-bearing.
            //
            // RV3.6 — but we MUST ignore Dolt's internal storage churn. bd's
            // embedded Dolt rewrites `.beads/embeddeddolt/.../.dolt/noms/manifest`
            // (+ journal.idx, nbs_manifest_*) on every READ. Watching those
            // recursively made each bd_snapshot's `bd ready`/`bd list` retrigger
            // bd_changed -> refetch -> Dolt touches manifest -> infinite loop
            // (perpetual 7-9s bd spawns, app idle). Only real issue-data writes
            // — the passive issues.jsonl export, config, top-level .beads files —
            // should fire bd_changed.
            if let Some(p) = event.paths.into_iter().next() {
                if is_dolt_internal(&p) {
                    return
                }
                let _ = tx.send(p);
            }
        }
    })
    .map_err(|e| format!("create watcher: {e}"))?;

    watcher
        .watch(&beads_dir, RecursiveMode::Recursive)
        .map_err(|e| format!("watch {}: {e}", beads_dir.display()))?;

    // Park the watcher so it isn't dropped at end-of-scope.
    {
        let mut guard = WATCHER.lock().map_err(|e| format!("watcher lock: {e}"))?;
        *guard = Some(WatcherState {
            watcher,
            repo_path: repo_path.clone(),
        });
    }

    // Debouncer + emitter task. Pulls events as they arrive, coalesces
    // anything that lands inside a 250ms window after the *first* event
    // of a burst, then emits a single `bd_changed:{repo_path}` payload.
    let event_name = format!("bd_changed:{repo_path}");
    tokio::spawn(async move {
        loop {
            // Block until the next event (or channel close).
            let first = match rx.recv().await {
                Some(p) => p,
                None => break,
            };
            let burst_started = Instant::now();
            let mut last_path = first;

            // Drain anything else that arrives within the debounce window.
            loop {
                let elapsed = burst_started.elapsed();
                if elapsed >= Duration::from_millis(DEBOUNCE_MS) {
                    break;
                }
                let remaining = Duration::from_millis(DEBOUNCE_MS) - elapsed;
                match tokio::time::timeout(remaining, rx.recv()).await {
                    Ok(Some(p)) => {
                        last_path = p;
                    }
                    Ok(None) => return, // channel closed, watcher dropped
                    Err(_) => break,    // timeout — burst is over
                }
            }

            let payload = BdChangedPayload {
                path: last_path.to_string_lossy().into_owned(),
                kind: "modify",
            };
            let _ = window.emit(&event_name, payload);
        }
    });

    Ok(())
}

/// Drop the active watcher. Idempotent — succeeds even when no watcher
/// is currently running.
#[tauri::command]
pub async fn watcher_stop() -> Result<(), String> {
    let mut guard = WATCHER.lock().map_err(|e| format!("watcher lock: {e}"))?;
    *guard = None; // Drop stops FSEvents.
    Ok(())
}

/// RV5.1 — true for a path the sensor cares about: a markdown file. Editor swap
/// files, `.DS_Store`, and directory events must NOT fire `sense_changed` or the
/// FE would rescan on churn. (Unlike the bd watcher there's no Dolt-internals
/// loop to guard against here; the `.md` gate is the whole filter.)
fn is_sensed_md(p: &Path) -> bool {
    p.extension()
        .map(|e| e.eq_ignore_ascii_case("md"))
        .unwrap_or(false)
}

/// Start watching the Obsidian sensor folders and emit a static `sense_changed`
/// event whenever a debounced `.md` change fires. The FE responds by running
/// `sense_scan` then `sense_list`.
///
/// `dirs` empty -> defaults to `sense::watched_dirs()` (the vault Implementation
/// Prompts/ + Daily/ folders); the FE normally passes nothing and lets Rust own
/// the vault path (single-sourced with daily.rs). Non-recursive: the sensed
/// folders are flat. Missing folders are skipped (not an error — the vault may
/// not have created them yet). A second call replaces the previous watchers.
#[tauri::command]
pub async fn sense_watch_start(window: Window, dirs: Vec<String>) -> Result<(), String> {
    let dirs: Vec<PathBuf> = if dirs.is_empty() {
        crate::sense::watched_dirs()
    } else {
        dirs.into_iter().map(PathBuf::from).collect()
    };

    let (tx, mut rx) = mpsc::unbounded_channel::<PathBuf>();

    let mut watchers: Vec<RecommendedWatcher> = Vec::new();
    for dir_path in &dirs {
        if !dir_path.exists() {
            continue;
        }
        let tx = tx.clone();
        let mut watcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if let Ok(event) = res {
                    if let Some(p) = event.paths.into_iter().next() {
                        if is_sensed_md(&p) {
                            let _ = tx.send(p);
                        }
                    }
                }
            })
            .map_err(|e| format!("create sense watcher: {e}"))?;
        watcher
            .watch(dir_path, RecursiveMode::NonRecursive)
            .map_err(|e| format!("watch {}: {e}", dir_path.display()))?;
        watchers.push(watcher);
    }

    {
        let mut guard = SENSE_WATCHER
            .lock()
            .map_err(|e| format!("sense watcher lock: {e}"))?;
        *guard = Some(watchers);
    }

    // Same 250ms debounce/coalesce shape as the bd watcher, but emits a static
    // `sense_changed` name (sensors are global, not per-repo).
    tokio::spawn(async move {
        loop {
            let _first = match rx.recv().await {
                Some(p) => p,
                None => break,
            };
            let burst_started = Instant::now();
            loop {
                let elapsed = burst_started.elapsed();
                if elapsed >= Duration::from_millis(DEBOUNCE_MS) {
                    break;
                }
                let remaining = Duration::from_millis(DEBOUNCE_MS) - elapsed;
                match tokio::time::timeout(remaining, rx.recv()).await {
                    Ok(Some(_)) => {}
                    Ok(None) => return,
                    Err(_) => break,
                }
            }
            let _ = window.emit("sense_changed", ());
        }
    });

    Ok(())
}

/// Drop the sensor watchers. Idempotent.
#[tauri::command]
pub async fn sense_watch_stop() -> Result<(), String> {
    let mut guard = SENSE_WATCHER
        .lock()
        .map_err(|e| format!("sense watcher lock: {e}"))?;
    *guard = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dolt_internals_are_ignored() {
        // The exact paths observed looping live (2026-08-01).
        assert!(is_dolt_internal(Path::new(
            "/home/x/Code/Beads-Station/.beads/embeddeddolt/Code/.dolt/noms/manifest"
        )));
        assert!(is_dolt_internal(Path::new(
            "/repo/.beads/embeddeddolt/Code/.dolt/noms/journal.idx"
        )));
        assert!(is_dolt_internal(Path::new(
            "/repo/.beads/embeddeddolt/Code/.dolt/noms/nbs_manifest_1353173261"
        )));
    }

    #[test]
    fn real_issue_data_changes_pass() {
        // These SHOULD fire bd_changed — a genuine bd write updates the export
        // and top-level metadata, not Dolt internals.
        assert!(!is_dolt_internal(Path::new("/repo/.beads/issues.jsonl")));
        assert!(!is_dolt_internal(Path::new("/repo/.beads/config.yaml")));
        assert!(!is_dolt_internal(Path::new("/repo/.beads/interactions.jsonl")));
        assert!(!is_dolt_internal(Path::new("/repo/.beads/last-touched")));
    }

    #[test]
    fn sensed_md_filter() {
        assert!(is_sensed_md(Path::new("/vault/Daily/2026-08-12.md")));
        assert!(is_sensed_md(Path::new("/vault/Implementation Prompts/rv51.MD")));
        assert!(!is_sensed_md(Path::new("/vault/Daily/.DS_Store")));
        assert!(!is_sensed_md(Path::new("/vault/Daily/note.txt")));
        assert!(!is_sensed_md(Path::new("/vault/Daily/note.md.swp")));
    }
}
