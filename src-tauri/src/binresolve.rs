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

/// nvm installs node (and globally-linked CLIs like `claude`) under
/// `~/.nvm/versions/node/<ver>/bin`, which is NOT one of CANONICAL_DIRS and is
/// absent from a GUI app's launchd-inherited PATH. Enumerate those bin dirs so
/// resolve_bin can find an nvm-managed `claude`/`bd`/`node` in a packaged dmg.
/// Newest version first (reverse lexical sort is a good-enough proxy — an
/// explicit configured path via BS_<NAME>_BIN always wins over this).
pub(crate) fn nvm_node_bin_dirs() -> Vec<PathBuf> {
    let Some(base) = expand_home("~/.nvm/versions/node") else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(&base) else { return Vec::new() };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .map(|p| p.join("bin"))
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    dirs.reverse();
    dirs
}

/// Resolve `name` to an absolute path of an executable file. Searches
/// CANONICAL_DIRS first, then falls back to splitting `$PATH`.
pub fn resolve_bin(name: &str) -> Result<PathBuf, String> {
    if let Ok(cache) = CACHE.lock() {
        if let Some(hit) = cache.get(name) {
            return Ok(hit.clone());
        }
    }

    // Pass 0: explicit override via env, e.g. BS_CLAUDE_BIN / BS_BD_BIN. Lets
    // the user (or the settings UI) pin an absolute path when auto-discovery
    // can't find a non-standard install. Wins over everything.
    let override_var = format!("BS_{}_BIN", name.to_uppercase());
    if let Ok(p) = std::env::var(&override_var) {
        let candidate = PathBuf::from(&p);
        if is_executable(&candidate) {
            if let Ok(mut cache) = CACHE.lock() {
                cache.insert(name.to_string(), candidate.clone());
            }
            return Ok(candidate);
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

    // Pass 1b: nvm-managed node bin dirs (newest first). This is where an
    // nvm user's globally-linked `claude`/`bd` actually live, and none of them
    // are on a GUI app's launchd PATH.
    for base in nvm_node_bin_dirs() {
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
        "binary '{name}' not found in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin, /usr/bin, /bin, ~/.nvm/versions/node/*/bin or PATH. Install {name}, symlink it into one of these directories, or set {override_var}=<absolute path>."
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

#[cfg(test)]
mod tests {
    use super::*;

    // Pass 0: BS_<NAME>_BIN override wins and resolves to that absolute path.
    // Point it at /bin/sh (present + executable on every macOS/Linux box) under
    // a name that can't exist on PATH, so only the override can satisfy it.
    #[test]
    fn env_override_resolves_to_absolute_path() {
        let name = "bs_test_override_bin";
        std::env::set_var("BS_BS_TEST_OVERRIDE_BIN_BIN", "/bin/sh");
        let resolved = resolve_bin(name).expect("override should resolve");
        assert_eq!(resolved, PathBuf::from("/bin/sh"));
        std::env::remove_var("BS_BS_TEST_OVERRIDE_BIN_BIN");
        // Clear the cache entry so the override doesn't leak into other tests.
        if let Ok(mut c) = CACHE.lock() {
            c.remove(name);
        }
    }

    // A bogus override path falls through to the normal search (and, for a
    // nonexistent binary name, ultimately errors) rather than being trusted.
    #[test]
    fn bogus_override_does_not_satisfy() {
        let name = "bs_test_missing_bin";
        std::env::set_var("BS_BS_TEST_MISSING_BIN_BIN", "/no/such/path/xyz");
        let r = resolve_bin(name);
        std::env::remove_var("BS_BS_TEST_MISSING_BIN_BIN");
        assert!(r.is_err(), "nonexistent name must not resolve via bogus override");
    }

    // nvm_node_bin_dirs never panics and only returns real bin directories.
    #[test]
    fn nvm_dirs_are_all_directories() {
        for d in nvm_node_bin_dirs() {
            assert!(d.is_dir(), "returned nvm path must be an existing dir: {d:?}");
        }
    }
}
