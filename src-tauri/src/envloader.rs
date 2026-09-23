// Optional gateway configuration. Native CLI login needs no .env file.
//
// macOS GUI apps launched from Finder do not inherit the user's shell
// environment. Without this loader, the spawned `claude` CLI has no
// ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL and silently fails to talk to
// the gateway. We read a deterministic .env at app startup, parse it,
// and inject into the Tauri process env so the claude.rs spawn inherits.
// Values are also explicitly forwarded via Command::env() in claude.rs
// to survive any environment scrubbing.
//
// SECURITY: never log values, only keys. Both the install summary and
// the diagnostic frames in claude.rs print presence/keys but never the
// secrets themselves.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use once_cell::sync::Lazy;

/// Cached path of the .env that won the search, populated by load_dotenv.
/// Used by `first_dotenv_path()` so the diagnostic line printed at startup
/// can show which file actually got loaded (or none).
static FIRST_PATH: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));

/// Cache of every path we searched, populated by load_dotenv. Used by
/// `loaded_summary()` when no .env was found, so the diagnostic line can
/// list the search list and let the user immediately see why nothing
/// loaded.
static SEARCHED_PATHS: Lazy<Mutex<Vec<PathBuf>>> = Lazy::new(|| Mutex::new(Vec::new()));

/// Native CLI login is the default. Gateway files are loaded only by opt-in.
pub fn gateway_enabled() -> bool {
    std::env::var("BS_AUTH_PROFILE").as_deref() == Ok("gateway")
}

pub fn prepare_auth_profile() {
    if !gateway_enabled() {
        // Do this once at startup, before worker threads are created. The CLI
        // retains its own local account credentials; stale gateway variables
        // must not override that account on a cloned machine.
        for key in [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
        ] {
            std::env::remove_var(key);
        }
    }
}

fn candidate_paths() -> Vec<PathBuf> {
    if !gateway_enabled() {
        return Vec::new();
    }
    std::env::var("BEADS_STATION_ENV")
        .ok()
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .into_iter()
        .collect()
}

/// Parse a single .env line into Some((key, value)) or None for malformed /
/// empty / comment lines. Strips surrounding double quotes from values so
/// KEY="value" works the same as KEY=value.
fn parse_line(raw: &str) -> Option<(String, String)> {
    let line = raw.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let eq = line.find('=')?;
    let key = line[..eq].trim().to_string();
    if key.is_empty() {
        return None;
    }
    let val_raw = line[eq + 1..].trim();
    let val = if val_raw.len() >= 2 && val_raw.starts_with('"') && val_raw.ends_with('"') {
        val_raw[1..val_raw.len() - 1].to_string()
    } else {
        val_raw.to_string()
    };
    Some((key, val))
}

/// Read the first .env we can find from candidate_paths(), parse it, and
/// return the key/value map. Records the winning path and the full search
/// list in module-local statics so loaded_summary / first_dotenv_path can
/// surface them later. Returns an empty map when no .env exists.
pub fn load_dotenv() -> HashMap<String, String> {
    let candidates = candidate_paths();
    if let Ok(mut s) = SEARCHED_PATHS.lock() {
        s.clear();
        s.extend(candidates.iter().cloned());
    }

    for path in &candidates {
        let Ok(contents) = std::fs::read_to_string(path) else {
            continue;
        };
        let mut map: HashMap<String, String> = HashMap::new();
        for line in contents.lines() {
            if let Some((k, v)) = parse_line(line) {
                map.insert(k, v);
            }
        }
        if let Ok(mut p) = FIRST_PATH.lock() {
            *p = Some(path.clone());
        }
        return map;
    }

    if let Ok(mut p) = FIRST_PATH.lock() {
        *p = None;
    }
    HashMap::new()
}

/// Push each (k, v) into std::env via set_var so child processes spawned later
/// inherit them. An already-present environment variable is NOT overwritten:
/// the live process environment wins over the `.env` file. This matters when
/// the app inherited a correct value (e.g. a gateway `ANTHROPIC_AUTH_TOKEN`
/// + `ANTHROPIC_BASE_URL=.../anthropic/`) — a stale repo `.env` must not clobber
/// it and point `claude` at a dead endpoint. `.env` only fills what the
/// environment is missing (the launchd-empty-PATH case). Returns the keys
/// actually installed (never values).
pub fn install_into_process_env(map: &HashMap<String, String>) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    for (k, v) in map {
        match std::env::var(k) {
            Ok(existing) if !existing.is_empty() => continue, // live env wins
            _ => {
                std::env::set_var(k, v);
                keys.push(k.clone());
            }
        }
    }
    keys.sort();
    keys
}

/// The path that won the most recent load_dotenv() call, if any. Used by
/// the startup diagnostic to print exactly which file we read.
pub fn first_dotenv_path() -> Option<PathBuf> {
    FIRST_PATH.lock().ok().and_then(|g| g.clone())
}

/// Human-readable one-liner for stderr at startup. Lists count + keys + the
/// winning path on success, or the search list on miss. Never prints values.
pub fn loaded_summary(keys: &[String]) -> String {
    if keys.is_empty() {
        let searched = SEARCHED_PATHS
            .lock()
            .ok()
            .map(|v| {
                v.iter()
                    .map(|p| p.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        format!("envloader: no .env found in [{searched}]")
    } else {
        let path_str = first_dotenv_path()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "<unknown>".to_string());
        format!(
            "envloader: loaded {} vars [{}] from {}",
            keys.len(),
            keys.join(", "),
            path_str
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_line_basic() {
        assert_eq!(
            parse_line("FOO=bar"),
            Some(("FOO".to_string(), "bar".to_string()))
        );
    }

    #[test]
    fn parse_line_quoted() {
        assert_eq!(
            parse_line("FOO=\"bar baz\""),
            Some(("FOO".to_string(), "bar baz".to_string()))
        );
    }

    #[test]
    fn parse_line_skips_comment_and_blank() {
        assert!(parse_line("# nothing").is_none());
        assert!(parse_line("").is_none());
        assert!(parse_line("   ").is_none());
    }

    #[test]
    fn parse_line_skips_malformed() {
        assert!(parse_line("nokey").is_none());
        assert!(parse_line("=novalkey").is_none());
    }

    #[test]
    fn parse_line_trims_whitespace() {
        assert_eq!(
            parse_line("  FOO  =  bar  "),
            Some(("FOO".to_string(), "bar".to_string()))
        );
    }

    #[test]
    fn install_does_not_clobber_existing_env() {
        // A live env var (e.g. a gateway ANTHROPIC_AUTH_TOKEN) must survive a
        // stale .env — the .env only fills what's missing.
        let present = "BS_ENVTEST_PRESENT";
        let missing = "BS_ENVTEST_MISSING";
        std::env::set_var(present, "live-value");
        std::env::remove_var(missing);

        let mut map = HashMap::new();
        map.insert(present.to_string(), "dotenv-value".to_string());
        map.insert(missing.to_string(), "dotenv-fill".to_string());
        let installed = install_into_process_env(&map);

        assert_eq!(std::env::var(present).unwrap(), "live-value"); // not clobbered
        assert_eq!(std::env::var(missing).unwrap(), "dotenv-fill"); // filled
        assert!(installed.contains(&missing.to_string()));
        assert!(!installed.contains(&present.to_string()));

        std::env::remove_var(present);
        std::env::remove_var(missing);
    }
}
