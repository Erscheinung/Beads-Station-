//! Release check: read this project's GitHub releases, compare the newest tag
//! with the running version, and download its DMG on request.
//!
//! The public GitHub API is tried first. While the repository is private that
//! returns 404, so the user's own `gh` CLI login is used instead; the app never
//! reads or stores a token. Nothing is installed here: the downloaded DMG is
//! opened in Finder and the user replaces the app, as with a manual download.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

const DEFAULT_REPOSITORY: &str = "Erscheinung/Beads-Station";

/// `owner/name` on github.com. `BS_UPDATE_REPO` points a checkout that tracks
/// a different remote at its own releases.
fn repository() -> String {
    std::env::var("BS_UPDATE_REPO")
        .ok()
        .filter(|value| is_repository_slug(value))
        .unwrap_or_else(|| DEFAULT_REPOSITORY.to_string())
}

fn is_repository_slug(value: &str) -> bool {
    let valid = |part: &str| {
        !part.is_empty()
            && !part.starts_with('.')
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    };
    matches!(value.split('/').collect::<Vec<_>>().as_slice(), [owner, name] if valid(owner) && valid(name))
}
const USER_AGENT: &str = concat!("beads-station/", env!("CARGO_PKG_VERSION"));

#[derive(Deserialize)]
struct ReleaseAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    assets: Vec<ReleaseAsset>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current: String,
    latest: Option<String>,
    newer: bool,
    url: Option<String>,
    /// DMG for this machine's architecture, when the release has one.
    asset: Option<String>,
}

/// Parse `v1.2.3` (or `1.2.3`). Tags with any other shape are ignored.
fn parse_version(tag: &str) -> Option<(u64, u64, u64)> {
    let mut parts = tag.strip_prefix('v').unwrap_or(tag).split('.');
    let version = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    parts.next().is_none().then_some(version)
}

fn dmg_suffix() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "aarch64.dmg"
    } else {
        "x64.dmg"
    }
}

fn summarize(current: &str, releases: &[Release]) -> UpdateInfo {
    let newest = releases
        .iter()
        .filter(|release| !release.draft)
        .filter_map(|release| parse_version(&release.tag_name).map(|version| (version, release)))
        .max_by_key(|(version, _)| *version);
    let current_version = parse_version(current);
    match newest {
        Some((version, release)) => UpdateInfo {
            current: current.to_string(),
            latest: Some(release.tag_name.clone()),
            newer: current_version.is_some_and(|running| version > running),
            url: Some(release.html_url.clone()),
            asset: release
                .assets
                .iter()
                .find(|asset| asset.name.ends_with(dmg_suffix()))
                .map(|asset| asset.name.clone()),
        },
        None => UpdateInfo {
            current: current.to_string(),
            latest: None,
            newer: false,
            url: None,
            asset: None,
        },
    }
}

fn releases_from_api() -> Result<Vec<Release>, String> {
    ureq::get(&format!(
        "https://api.github.com/repos/{}/releases?per_page=20",
        repository()
    ))
    .set("User-Agent", USER_AGENT)
    .set("Accept", "application/vnd.github+json")
    .timeout(Duration::from_secs(10))
    .call()
    .map_err(|error| error.to_string())?
    .into_json()
    .map_err(|error| error.to_string())
}

fn releases_from_gh() -> Result<Vec<Release>, String> {
    let gh = crate::binresolve::resolve_bin("gh")?;
    let output = Command::new(gh)
        .args(["api", &format!("repos/{}/releases?per_page=20", repository())])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("gh could not read the releases (is it logged in?)".into());
    }
    serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())
}

fn fetch_releases() -> Result<Vec<Release>, String> {
    releases_from_api().or_else(|api_error| {
        releases_from_gh().map_err(|gh_error| {
            format!("Could not read releases. GitHub API: {api_error}. gh CLI: {gh_error}")
        })
    })
}

#[tauri::command]
pub async fn app_check_update() -> Result<UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(|| {
        fetch_releases().map(|releases| summarize(env!("CARGO_PKG_VERSION"), &releases))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn downloads_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    Ok(PathBuf::from(home).join("Downloads"))
}

fn download_with_gh(tag: &str, dir: &PathBuf) -> Result<(), String> {
    let gh = crate::binresolve::resolve_bin("gh")?;
    let dmg = format!("*{}", dmg_suffix());
    let checksum = format!("*{}.sha256", dmg_suffix());
    let status = Command::new(gh)
        .args(["release", "download", tag, "--repo", &repository(), "--clobber"])
        .args(["--pattern", &dmg, "--pattern", &checksum, "--dir"])
        .arg(dir)
        .status()
        .map_err(|error| error.to_string())?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "gh release download failed".to_string())
}

fn download_with_http(release: &Release, dir: &PathBuf) -> Result<(), String> {
    for asset in &release.assets {
        let wanted = asset.name.ends_with(dmg_suffix())
            || asset.name.ends_with(&format!("{}.sha256", dmg_suffix()));
        // Asset names become file names; never let one escape the folder.
        if !wanted || asset.name.contains('/') || asset.name.contains("..") {
            continue;
        }
        let response = ureq::get(&asset.browser_download_url)
            .set("User-Agent", USER_AGENT)
            .call()
            .map_err(|error| error.to_string())?;
        let mut file =
            std::fs::File::create(dir.join(&asset.name)).map_err(|error| error.to_string())?;
        std::io::copy(&mut response.into_reader(), &mut file).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Compare the DMG with its published `.sha256` when the release ships one.
fn verify_checksum(dmg: &PathBuf) -> Result<bool, String> {
    let checksum_path = PathBuf::from(format!("{}.sha256", dmg.display()));
    let Ok(published) = std::fs::read_to_string(&checksum_path) else {
        return Ok(false);
    };
    let expected = published.split_whitespace().next().unwrap_or_default();
    let output = Command::new("/usr/bin/shasum")
        .args(["-a", "256"])
        .arg(dmg)
        .output()
        .map_err(|error| error.to_string())?;
    let actual = String::from_utf8_lossy(&output.stdout);
    let actual = actual.split_whitespace().next().unwrap_or_default();
    if expected.is_empty() || !expected.eq_ignore_ascii_case(actual) {
        let _ = std::fs::remove_file(dmg);
        return Err("The downloaded DMG does not match its published SHA-256; it was deleted.".into());
    }
    Ok(true)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedUpdate {
    path: String,
    checksum_verified: bool,
}

/// Download a release's DMG to ~/Downloads, verify it, and open it in Finder.
#[tauri::command]
pub async fn app_download_update(tag: String) -> Result<DownloadedUpdate, String> {
    if parse_version(&tag).is_none() {
        return Err("Invalid release tag".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let releases = fetch_releases()?;
        let release = releases
            .iter()
            .find(|release| release.tag_name == tag && !release.draft)
            .ok_or("That release no longer exists")?;
        let asset = release
            .assets
            .iter()
            .find(|asset| asset.name.ends_with(dmg_suffix()))
            .ok_or("This release has no DMG for this Mac")?;
        let dir = downloads_dir()?;
        std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        download_with_gh(&tag, &dir).or_else(|_| download_with_http(release, &dir))?;
        let dmg = dir.join(&asset.name);
        if !dmg.is_file() {
            return Err("The DMG was not downloaded".into());
        }
        let checksum_verified = verify_checksum(&dmg)?;
        Command::new("/usr/bin/open")
            .arg(&dmg)
            .status()
            .map_err(|error| error.to_string())?;
        Ok(DownloadedUpdate {
            path: dmg.display().to_string(),
            checksum_verified,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, draft: bool, assets: &[&str]) -> Release {
        Release {
            tag_name: tag.into(),
            html_url: format!("https://example.invalid/{tag}"),
            draft,
            assets: assets
                .iter()
                .map(|name| ReleaseAsset {
                    name: (*name).into(),
                    browser_download_url: format!("https://example.invalid/{name}"),
                })
                .collect(),
        }
    }

    #[test]
    fn parses_only_three_part_numeric_tags() {
        assert_eq!(parse_version("v0.1.10"), Some((0, 1, 10)));
        assert_eq!(parse_version("1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version("v1.2"), None);
        assert_eq!(parse_version("v1.2.3.4"), None);
        assert_eq!(parse_version("nightly"), None);
    }

    #[test]
    fn repository_override_must_be_an_owner_and_name() {
        assert!(is_repository_slug("owner/beads-station"));
        assert!(!is_repository_slug("owner"));
        assert!(!is_repository_slug("owner/name/extra"));
        assert!(!is_repository_slug("owner/na me"));
        assert!(!is_repository_slug("../name"));
    }

    #[test]
    fn newest_published_release_wins_and_compares_numerically() {
        let releases = [
            release("v0.1.9", false, &[]),
            release("v0.1.10", false, &["Beads.Station_0.1.10_aarch64.dmg"]),
            release("v0.2.0", true, &[]),
            release("nightly", false, &[]),
        ];
        let info = summarize("0.1.9", &releases);
        assert_eq!(info.latest.as_deref(), Some("v0.1.10"));
        assert!(info.newer);
        assert_eq!(info.asset.is_some(), cfg!(target_arch = "aarch64"));
    }

    #[test]
    fn running_the_newest_release_is_not_an_update() {
        let info = summarize("0.1.5", &[release("v0.1.5", false, &[]), release("v0.1.4", false, &[])]);
        assert_eq!(info.latest.as_deref(), Some("v0.1.5"));
        assert!(!info.newer);
        assert!(!summarize("0.1.5", &[]).newer);
    }

    /// Opt-in: reads the real release list (public API, then the `gh` login).
    /// `cargo test -- --ignored live_release_check`
    #[test]
    #[ignore]
    fn live_release_check_reads_published_releases() {
        let releases = fetch_releases().expect("release list");
        let info = summarize(env!("CARGO_PKG_VERSION"), &releases);
        eprintln!("{info:?}");
        assert!(info.latest.is_some_and(|tag| parse_version(&tag).is_some()));
        assert!(info.url.is_some());
    }
}
