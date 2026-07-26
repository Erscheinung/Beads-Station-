// RV3-B (Code-8ro) — filesystem bridge for the file-navigation pane.
//
// Two commands, both pure std::fs / the `ignore` crate — NO subprocess spawn
// (R3.5 discipline: the GUI inherits an empty PATH under launchd, and shelling
// out per entry would burn fds and PATH-fail). gitignore filtering is done
// in-process by the `ignore` crate (ripgrep's engine).
//
//   list_dir(path)            — one level of children, gitignore-aware, sorted
//                               dirs-first. LAZY: the tree expands per-level as
//                               the user navigates, so we never walk a whole
//                               repo (bounds fd + memory; see R3.5 EMFILE).
//   read_file(path, max_bytes)— a bounded prefix of a file for read-only
//                               preview. Never loads a huge/binary file whole
//                               into the webview.

use std::path::{Path, PathBuf};

use ignore::WalkBuilder;
use serde::Serialize;

/// One directory entry surfaced to the file-nav tree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    /// Absolute path — used as the tree node id (unique + stable).
    pub path: String,
    /// Base name for display.
    pub name: String,
    pub is_dir: bool,
}

/// Cap on entries returned for a single directory. A directory with more
/// children than this is truncated (the FE shows a "…truncated" marker). Keeps
/// a pathological node (e.g. a generated dir with 100k files) from flooding the
/// webview. Not a recursion cap — listing is one level deep by construction.
const MAX_ENTRIES: usize = 2000;

/// Default read_file cap (256 KiB) when the FE doesn't specify one. Enough for
/// any hand-written source file; guards against loading a huge/binary blob.
const DEFAULT_MAX_BYTES: usize = 256 * 1024;
const HARD_MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub entries: Vec<DirEntry>,
    /// True when the directory had more than MAX_ENTRIES children.
    pub truncated: bool,
}

/// List the immediate children of `path`, honoring .gitignore/.ignore rooted
/// at that directory's repo. Directories sort before files, then by name
/// (case-insensitive). One level only — the caller lists a child dir on expand.
#[tauri::command]
pub fn list_dir(path: String) -> Result<DirListing, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {path}"));
    }

    // max_depth(1) => root + immediate children only. The `ignore` walker
    // applies .gitignore, .ignore, global gitignore, and hidden-file rules by
    // default; we keep hidden files visible (a nav pane should show dotfiles)
    // but still respect gitignore. standard_filters stays on for gitignore;
    // hidden(false) re-enables dotfiles.
    let walker = WalkBuilder::new(&root)
        .max_depth(Some(1))
        .hidden(false) // show dotfiles (.env etc.) — but gitignore still hides ignored ones
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .build();

    let mut entries: Vec<DirEntry> = Vec::new();
    let mut truncated = false;

    for result in walker {
        let dent = match result {
            Ok(d) => d,
            Err(_) => continue, // skip unreadable entries rather than fail the whole listing
        };
        // depth 0 is `root` itself — skip it.
        if dent.depth() == 0 {
            continue;
        }
        let p = dent.path();
        let name = match p.file_name() {
            Some(n) => n.to_string_lossy().into_owned(),
            None => continue,
        };
        let is_dir = dent.file_type().map(|t| t.is_dir()).unwrap_or(false);
        entries.push(DirEntry {
            path: p.to_string_lossy().into_owned(),
            name,
            is_dir,
        });
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir) // dirs first
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(DirListing { entries, truncated })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    pub path: String,
    pub content: String,
    /// True when the file was longer than the byte cap (content is a prefix).
    pub truncated: bool,
    /// True when the bytes weren't valid UTF-8 (content is lossy-decoded).
    pub binary: bool,
    pub total_bytes: u64,
}

/// Read a bounded UTF-8 prefix of a file for read-only preview. `max_bytes`
/// clamps to [1, HARD_MAX_BYTES]; None => DEFAULT_MAX_BYTES. Non-UTF-8 bytes
/// are lossy-decoded and flagged `binary` so the FE can warn instead of
/// rendering garbage.
#[tauri::command]
pub fn read_file(path: String, max_bytes: Option<usize>) -> Result<FilePreview, String> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let meta = std::fs::metadata(p).map_err(|e| format!("stat {path}: {e}"))?;
    let total_bytes = meta.len();

    let cap = max_bytes
        .unwrap_or(DEFAULT_MAX_BYTES)
        .clamp(1, HARD_MAX_BYTES);

    // Read only up to cap+1 bytes so we can tell "exactly cap" from "more".
    use std::io::Read;
    let mut f = std::fs::File::open(p).map_err(|e| format!("open {path}: {e}"))?;
    let mut buf = vec![0u8; cap];
    let n = f.read(&mut buf).map_err(|e| format!("read {path}: {e}"))?;
    buf.truncate(n);
    let truncated = (n as u64) < total_bytes;

    let (content, binary) = match String::from_utf8(buf.clone()) {
        Ok(s) => (s, false),
        Err(_) => (String::from_utf8_lossy(&buf).into_owned(), true),
    };

    Ok(FilePreview {
        path,
        content,
        truncated,
        binary,
        total_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn list_dir_rejects_non_dir() {
        assert!(list_dir("/definitely/not/a/dir/xyz".into()).is_err());
    }

    #[test]
    fn read_file_bounds_and_flags() {
        // Write a temp file larger than a tiny cap.
        let mut path = std::env::temp_dir();
        path.push(format!("bs-rv3b-test-{}.txt", std::process::id()));
        {
            let mut f = std::fs::File::create(&path).unwrap();
            f.write_all(b"hello world, this is more than ten bytes").unwrap();
        }
        let prev = read_file(path.to_string_lossy().into_owned(), Some(10)).unwrap();
        assert_eq!(prev.content.len(), 10);
        assert!(prev.truncated);
        assert!(!prev.binary);
        assert_eq!(prev.total_bytes, 40);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn list_dir_lists_children_dirs_first() {
        // Build a temp dir with a subdir and a file.
        let mut root = std::env::temp_dir();
        root.push(format!("bs-rv3b-listdir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("subdir")).unwrap();
        std::fs::File::create(root.join("z_file.txt")).unwrap();
        let listing = list_dir(root.to_string_lossy().into_owned()).unwrap();
        // dir sorts before file
        assert_eq!(listing.entries[0].name, "subdir");
        assert!(listing.entries[0].is_dir);
        assert!(listing.entries.iter().any(|e| e.name == "z_file.txt" && !e.is_dir));
        let _ = std::fs::remove_dir_all(&root);
    }
}
