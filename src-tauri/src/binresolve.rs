// Beads Station — Phase 2.5 binary resolver.
//
// GUI apps launched on macOS inherit PATH from launchd, not from the user's
// login shell. `launchctl getenv PATH` is empty in many configurations, so
// `Command::new("bd")` fails with "No such file or directory" because
// ~/.local/bin and /opt/homebrew/bin are absent from the inherited PATH.
//
// resolve_bin walks a static set of canonical install dirs first, then
// falls back to whatever PATH is present. Results are cached in-process
// so we don't re-stat per spawn.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use once_cell::sync::Lazy;

/// Cache of name → resolved absolute path so repeated bd/claude spawns
/// don't re-stat the filesystem.
static CACHE: Lazy<Mutex<HashMap<String, PathBuf>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Canonical install directories to search first, in priority order.
/// HOME-relative entries are expanded at lookup time.
const CANONICAL_DIRS: &[&str] = &[
    "~/.local/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
];

#[cfg(unix)]
fn is_executable(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(path) {
        Ok(md) => md.is_file() && (md.permissions().mode() & 0o111) != 0,
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn is_executable(path: &std::path::Path) -> bool {
    std::fs::metadata(path).map(|md| md.is_file()).unwrap_or(false)
}

fn expand_home(dir: &str) -> Option<PathBuf> {
    if let Some(rest) = dir.strip_prefix("~/") {
        let home = std::env::var("HOME").ok()?;
        Some(PathBuf::from(home).join(rest))
    } else if dir == "~" {
        std::env::var("HOME").ok().map(PathBuf::from)
    } else {
        Some(PathBuf::from(dir))
    }
}

/// Resolve `name` to an absolute path of an executable file. Searches
/// CANONICAL_DIRS first, then falls back to splitting `$PATH`.
pub fn resolve_bin(name: &str) -> Result<PathBuf, String> {
    if let Ok(cache) = CACHE.lock() {
        if let Some(hit) = cache.get(name) {
            return Ok(hit.clone());
        }
    }

    // Pass 1: canonical install dirs.
    for dir in CANONICAL_DIRS {
        let Some(base) = expand_home(dir) else { continue };
        let candidate = base.join(name);
        if is_executable(&candidate) {
            if let Ok(mut cache) = CACHE.lock() {
                cache.insert(name.to_string(), candidate.clone());
            }
            return Ok(candidate);
        }
    }

    // Pass 2: PATH fallback (in case the binary was installed somewhere
    // unusual that the user has on PATH but we haven't enumerated).
    if let Ok(path_env) = std::env::var("PATH") {
        for dir in path_env.split(':') {
            if dir.is_empty() {
                continue;
            }
            let candidate = PathBuf::from(dir).join(name);
            if is_executable(&candidate) {
                if let Ok(mut cache) = CACHE.lock() {
                    cache.insert(name.to_string(), candidate.clone());
                }
                return Ok(candidate);
            }
        }
    }

    Err(format!(
        "binary '{name}' not found in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin, /usr/bin, /bin or PATH. Install {name} or symlink it into one of these directories."
    ))
}

/// Like resolve_bin, but if the search fails fall back to `fallback_abs_path`
/// when that path itself exists and is executable. Used for the historical
/// CLAUDE_BIN-style hardcode pattern.
pub fn resolve_bin_or_default(
    name: &str,
    fallback_abs_path: &str,
) -> Result<PathBuf, String> {
    match resolve_bin(name) {
        Ok(p) => Ok(p),
        Err(orig) => {
            let fb = PathBuf::from(fallback_abs_path);
            if is_executable(&fb) {
                if let Ok(mut cache) = CACHE.lock() {
                    cache.insert(name.to_string(), fb.clone());
                }
                Ok(fb)
            } else {
                Err(orig)
            }
        }
    }
}
