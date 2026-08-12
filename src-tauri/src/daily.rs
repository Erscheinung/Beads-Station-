// Phase 7 (bd ticket Code-ky4.7) — Obsidian daily writer.
//
// A Rust-side append-only writer for the durable log the conductor pulse
// (RV4.1) writes back to. One file per day at
//   ~/Documents/Beads/Daily/{YYYY-MM-DD}.md
// with an `# {YYYY-MM-DD} — Beads Update` H1 and `## HH:MM — <title>`
// subsections appended in arrival order. No frontmatter (the vault convention;
// these files are read as plain notes, not dataview-queried).
//
// Pure std::fs — NO subprocess spawn (R3.5 discipline: the GUI inherits an
// empty PATH under launchd). Local wall-clock date/time via chrono::Local so
// the filename and the HH:MM stamp match the vault the human reads, not UTC.
//
// Append is idempotent at the FILE level (header written once), not the
// SECTION level: two "18:40 — X" calls append two subsections by design — the
// conductor logs each pulse, and repeated titles at different minutes are real
// distinct events. The caller owns dedup if it wants it.

use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::Local;
use serde::Serialize;

/// Default vault location for daily logs. Resolved relative to $HOME so it
/// survives a different macOS user, with a hardcoded fallback matching the
/// established path when $HOME is somehow unset.
fn default_daily_dir() -> PathBuf {
    match std::env::var_os("HOME") {
        Some(home) => Path::new(&home).join("Documents/Beads/Daily"),
        None => PathBuf::from("~/Documents/Beads/Daily"),
    }
}

/// Result surfaced to the FE / caller: which file was touched and whether this
/// call created it (drives a "started today's log" vs "appended" distinction).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyWrite {
    /// Absolute path to the daily file that was written.
    pub path: String,
    /// The `YYYY-MM-DD` date key the file is named for.
    pub date: String,
    /// True when this call created the file (wrote the H1 header).
    pub created: bool,
}

/// The H1 a fresh daily file opens with. Matches the Phase-7 ticket spec
/// (`# {YYYY-MM-DD} — Beads Update`).
fn header_line(date: &str) -> String {
    format!("# {date} — Beads Update")
}

/// True if `existing` already carries a daily H1 for `date` in either the
/// spec form (`# {date} — Beads Update`) or the older bare form (`# {date}`)
/// that hand-written files used before this phase. Keeps us from stacking a
/// second header onto a file a human already started today.
fn has_header(existing: &str, date: &str) -> bool {
    let bare = format!("# {date}");
    existing.lines().any(|l| {
        let t = l.trim_end();
        t == bare || t == header_line(date)
    })
}

/// Render one `## HH:MM — <title>` subsection with its body. Blank line before
/// the heading (so it separates cleanly from the prior block) and after, so the
/// next append doesn't butt against this body. Title/body are trimmed; an empty
/// body yields just the heading.
fn render_section(hhmm: &str, title: &str, body: &str) -> String {
    let title = title.trim();
    let body = body.trim();
    if body.is_empty() {
        format!("\n## {hhmm} — {title}\n")
    } else {
        format!("\n## {hhmm} — {title}\n\n{body}\n")
    }
}

/// Append a timestamped subsection to today's daily file, creating it (with the
/// H1) if absent. Writes are append-only, so concurrent calls never clobber
/// each other's sections. `dir_override` lets tests target a temp dir instead
/// of the real vault; production passes `None`.
///
/// Returns the path + whether the file was created this call. Errors are
/// stringified (Tauri command convention) — a failed write never panics.
pub fn append_section(
    title: &str,
    body: &str,
    dir_override: Option<&Path>,
) -> Result<DailyWrite, String> {
    let now = Local::now();
    let date = now.format("%Y-%m-%d").to_string();
    let hhmm = now.format("%H:%M").to_string();

    let dir = match dir_override {
        Some(d) => d.to_path_buf(),
        None => default_daily_dir(),
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let file = dir.join(format!("{date}.md"));

    // Read the current head only to decide whether the H1 already exists. The
    // WRITE is append-only (OpenOptions append) — never a read-modify-`fs::write`
    // — so a concurrent append from a second pulse/FE call can NEVER clobber an
    // already-written section: both appends land, ordered by the OS. The only
    // residual race is two writers seeing an empty file at the same instant and
    // both prepending an H1 (a rare cosmetic double header on same-day, same-
    // instant first-writes from two processes — not a data-loss path); the
    // `has_header` dedup makes even that impossible for any non-simultaneous
    // call, which is every real path here (single FE + non-overlapping pulses).
    let existing = std::fs::read_to_string(&file).unwrap_or_default();
    let need_header = !has_header(&existing, &date);

    let mut chunk = String::new();
    if need_header {
        // If a headerless file somehow exists, make sure our H1 starts on its
        // own line rather than gluing onto a trailing partial line.
        if !existing.is_empty() && !existing.ends_with('\n') {
            chunk.push('\n');
        }
        chunk.push_str(&header_line(&date));
        chunk.push('\n');
    }
    chunk.push_str(&render_section(&hhmm, title, body));

    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .map_err(|e| format!("open {}: {e}", file.display()))?;
    f.write_all(chunk.as_bytes())
        .map_err(|e| format!("write {}: {e}", file.display()))?;

    Ok(DailyWrite {
        path: file.to_string_lossy().into_owned(),
        date,
        created: need_header,
    })
}

/// Manual "Save Update" command + the surface RV4.1's pulse log step calls.
/// `dir_override` is exposed so a test harness (or a future per-vault setting)
/// can redirect the write; the FE passes `None`/omits it for the real vault.
#[tauri::command]
pub fn daily_append(
    title: String,
    body: String,
    dir_override: Option<String>,
) -> Result<DailyWrite, String> {
    let dir = dir_override.map(PathBuf::from);
    append_section(&title, &body, dir.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let mut d = std::env::temp_dir();
        d.push(format!("bs-phase7-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn has_header_matches_both_forms() {
        assert!(has_header("# 2026-08-12 — Beads Update\n\n## 09:00 — x", "2026-08-12"));
        assert!(has_header("# 2026-08-12\n\n## 09:00 — x", "2026-08-12")); // bare legacy form
        assert!(!has_header("# 2026-08-11 — Beads Update", "2026-08-12"));
        assert!(!has_header("", "2026-08-12"));
    }

    #[test]
    fn render_section_shapes() {
        assert_eq!(render_section("09:30", "Title", "body"), "\n## 09:30 — Title\n\nbody\n");
        assert_eq!(render_section("09:30", " Title ", "  "), "\n## 09:30 — Title\n");
    }

    #[test]
    fn first_write_creates_file_with_header() {
        let dir = temp_dir("create");
        let w = append_section("First thing", "did a thing", Some(&dir)).unwrap();
        assert!(w.created);
        let contents = std::fs::read_to_string(&w.path).unwrap();
        assert!(contents.starts_with(&format!("# {} — Beads Update\n", w.date)));
        assert!(contents.contains("— First thing\n"));
        assert!(contents.contains("did a thing"));
        // Exactly one H1.
        assert_eq!(contents.lines().filter(|l| l.starts_with("# ")).count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn second_write_appends_without_new_header() {
        let dir = temp_dir("append");
        let w1 = append_section("One", "a", Some(&dir)).unwrap();
        let w2 = append_section("Two", "b", Some(&dir)).unwrap();
        assert!(w1.created);
        assert!(!w2.created);
        assert_eq!(w1.path, w2.path);
        let contents = std::fs::read_to_string(&w2.path).unwrap();
        // Still exactly one H1, both subsections present, order preserved.
        assert_eq!(contents.lines().filter(|l| l.starts_with("# ")).count(), 1);
        assert_eq!(contents.matches("## ").count(), 2);
        let one = contents.find("— One").unwrap();
        let two = contents.find("— Two").unwrap();
        assert!(one < two);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn adopts_existing_headerless_or_legacy_file() {
        let dir = temp_dir("legacy");
        std::fs::create_dir_all(&dir).unwrap();
        let date = Local::now().format("%Y-%m-%d").to_string();
        let file = dir.join(format!("{date}.md"));
        // A human already started the file with the bare-form header.
        std::fs::write(&file, format!("# {date}\n\n## 08:00 — manual\n\nnote\n")).unwrap();
        let w = append_section("Auto", "pulse", Some(&dir)).unwrap();
        assert!(!w.created); // legacy header recognized, no duplicate
        let contents = std::fs::read_to_string(&file).unwrap();
        assert_eq!(contents.lines().filter(|l| l.starts_with("# ")).count(), 1);
        assert!(contents.contains("## 08:00 — manual"));
        assert!(contents.contains("— Auto"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_appends_never_clobber() {
        // Fire N appends against the same file from many threads. Append-only
        // writes must preserve every section (no read-modify-write clobber).
        let dir = temp_dir("concurrent");
        std::fs::create_dir_all(&dir).unwrap();
        let n = 16;
        let handles: Vec<_> = (0..n)
            .map(|i| {
                let d = dir.clone();
                std::thread::spawn(move || {
                    append_section(&format!("t{i}"), &format!("body{i}"), Some(&d)).unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let date = Local::now().format("%Y-%m-%d").to_string();
        let contents = std::fs::read_to_string(dir.join(format!("{date}.md"))).unwrap();
        // Every section survived.
        for i in 0..n {
            assert!(contents.contains(&format!("— t{i}\n")), "lost section t{i}");
            assert!(contents.contains(&format!("body{i}")), "lost body{i}");
        }
        // At most a small number of headers (ideally 1; the same-instant race
        // can add a few, but never data loss). Assert it never explodes.
        let headers = contents.lines().filter(|l| l.starts_with("# ")).count();
        assert!(headers >= 1 && headers <= n, "unexpected header count {headers}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
