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

/// Download a release's DMG (and its checksum) into `dir` and verify it.
fn download_release(tag: &str, dir: &PathBuf) -> Result<(PathBuf, bool), String> {
    if parse_version(tag).is_none() {
        return Err("Invalid release tag".into());
    }
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
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    download_with_gh(tag, dir).or_else(|_| download_with_http(release, dir))?;
    let dmg = dir.join(&asset.name);
    if !dmg.is_file() {
        return Err("The DMG was not downloaded".into());
    }
    let checksum_verified = verify_checksum(&dmg)?;
    Ok((dmg, checksum_verified))
}

/// Download a release's DMG to ~/Downloads, verify it, and open it in Finder.
#[tauri::command]
pub async fn app_download_update(tag: String) -> Result<DownloadedUpdate, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (dmg, checksum_verified) = download_release(&tag, &downloads_dir()?)?;
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

// ── Installing an update in place (Code-t3w.2) ──────────────────────────────
//
// The app is ad-hoc signed, so macOS's own update frameworks are not
// available. Instead: download and verify the DMG, check the app inside it,
// copy it next to the running bundle, and after the app has quit swap the two
// and start the new one. Every step that changes anything is the result of an
// explicit click, and quitting goes through the normal close confirmation.

const BUNDLE_IDENTIFIER: &str = "ai.beads-station.desktop";
/// How long the swap waits for the app to quit before giving up.
const SWAP_WAIT_SECONDS: u32 = 900;

/// The `.app` bundle this executable runs from, when it is an installed app.
fn bundle_of(executable: &std::path::Path) -> Option<PathBuf> {
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension().is_some_and(|extension| extension == "app"))
    .then(|| bundle.to_path_buf())
}

fn running_bundle() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let executable = std::fs::canonicalize(&executable).unwrap_or(executable);
    bundle_of(&executable).ok_or_else(|| "Only the installed app can update itself; this build is not running from an .app bundle.".to_string())
}

/// Where the new bundle waits: a hidden sibling, so the final swap is a rename on one volume.
fn staged_bundle(bundle: &std::path::Path) -> Option<PathBuf> {
    let name = bundle.file_name()?.to_string_lossy().into_owned();
    Some(bundle.with_file_name(format!(".{name}.update")))
}

fn plist_value(bundle: &std::path::Path, key: &str) -> Result<String, String> {
    let output = Command::new("/usr/bin/plutil")
        .args(["-extract", key, "raw", "-o", "-"])
        .arg(bundle.join("Contents/Info.plist"))
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!("The downloaded app has no {key}"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// The downloaded app must be this app, at the expected version, with an intact signature.
fn check_downloaded_bundle(bundle: &std::path::Path, tag: &str) -> Result<(), String> {
    let identifier = plist_value(bundle, "CFBundleIdentifier")?;
    if identifier != BUNDLE_IDENTIFIER {
        return Err(format!("The downloaded app is {identifier}, not Beads Station"));
    }
    let version = plist_value(bundle, "CFBundleShortVersionString")?;
    if parse_version(&version) != parse_version(tag) {
        return Err(format!("The downloaded app is version {version}, not {tag}"));
    }
    let signature = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(bundle)
        .output()
        .map_err(|error| error.to_string())?;
    if !signature.status.success() {
        return Err("The downloaded app's code signature is not intact".into());
    }
    Ok(())
}

fn find_app(dir: &std::path::Path) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.extension().is_some_and(|extension| extension == "app"))
}

/// Mount the DMG, check its app, and copy it to the staging place.
fn stage_from_dmg(dmg: &std::path::Path, tag: &str, staged: &std::path::Path, work: &std::path::Path) -> Result<(), String> {
    let mount = work.join("mount");
    let _ = std::fs::remove_dir_all(&mount);
    std::fs::create_dir_all(&mount).map_err(|error| error.to_string())?;
    let attached = Command::new("/usr/bin/hdiutil")
        .args(["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint"])
        .arg(&mount)
        .arg(dmg)
        .output()
        .map_err(|error| error.to_string())?;
    if !attached.status.success() {
        return Err("The downloaded disk image could not be opened".into());
    }
    let result = (|| {
        let app = find_app(&mount).ok_or("The disk image contains no app")?;
        check_downloaded_bundle(&app, tag)?;
        let _ = std::fs::remove_dir_all(staged);
        let copied = Command::new("/usr/bin/ditto").arg(&app).arg(staged).status().map_err(|error| error.to_string())?;
        if !copied.success() {
            let _ = std::fs::remove_dir_all(staged);
            return Err("The new app could not be copied next to the installed one (is that folder writable?)".to_string());
        }
        // The copy is what will run; check it too.
        check_downloaded_bundle(staged, tag).inspect_err(|_| {
            let _ = std::fs::remove_dir_all(staged);
        })
    })();
    let _ = Command::new("/usr/bin/hdiutil").args(["detach", "-quiet"]).arg(&mount).status();
    result
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedUpdate {
    version: String,
    /// The installed bundle that will be replaced.
    bundle: String,
}

/// Download, verify and stage a release next to the installed app. Nothing is
/// replaced yet and the app keeps running.
#[tauri::command]
pub async fn app_prepare_update(app: tauri::AppHandle, tag: String) -> Result<StagedUpdate, String> {
    use tauri::Manager;
    let bundle = running_bundle()?;
    let staged = staged_bundle(&bundle).ok_or("The installed app has no usable name")?;
    let work = app.path().app_cache_dir().map_err(|error| error.to_string())?.join("update");
    tauri::async_runtime::spawn_blocking(move || {
        let (dmg, checksum_verified) = download_release(&tag, &work)?;
        if !checksum_verified {
            let _ = std::fs::remove_file(&dmg);
            return Err("This release publishes no SHA-256, so it will not be installed automatically. Download it instead.".to_string());
        }
        let staged_result = stage_from_dmg(&dmg, &tag, &staged, &work);
        let _ = std::fs::remove_file(&dmg);
        staged_result?;
        Ok(StagedUpdate { version: tag, bundle: bundle.display().to_string() })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Shell program that waits for process `$1` to exit, then replaces bundle
/// `$2` with staged bundle `$3` and runs the remaining arguments (the
/// relaunch). If the app has not quit in time, or the swap fails, the
/// installed app is left exactly as it was.
const SWAP_SCRIPT: &str = r#"
pid="$1"; bundle="$2"; staged="$3"; wait="$4"; shift 4
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -gt "$((wait * 5))" ] && exit 0
  sleep 0.2
done
[ -d "$staged" ] || exit 0
old="$bundle.previous"
rm -rf "$old"
if mv "$bundle" "$old"; then
  if mv "$staged" "$bundle"; then rm -rf "$old"; else mv "$old" "$bundle"; fi
fi
"$@"
"#;

fn spawn_swap(pid: u32, bundle: &std::path::Path, staged: &std::path::Path, wait_seconds: u32, relaunch: &[&std::ffi::OsStr]) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", SWAP_SCRIPT, "beads-station-update"])
        .arg(pid.to_string())
        .arg(bundle)
        .arg(staged)
        .arg(wait_seconds.to_string())
        .args(relaunch)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        // Its own process group, so it outlives the app it is waiting for.
        .process_group(0);
    command.spawn().map(|_| ()).map_err(|error| format!("could not start the update step: {error}"))
}

/// Ask the app to quit (through the usual confirmation) and, once it has,
/// replace it with the staged update and start the new version.
#[tauri::command]
pub fn app_apply_update(app: tauri::AppHandle, state: tauri::State<'_, crate::app_lifecycle::CloseCoordinator>) -> Result<(), String> {
    let bundle = running_bundle()?;
    let staged = staged_bundle(&bundle).filter(|staged| staged.is_dir()).ok_or("No update has been prepared")?;
    let open = std::ffi::OsStr::new("/usr/bin/open");
    spawn_swap(std::process::id(), &bundle, &staged, SWAP_WAIT_SECONDS, &[open, bundle.as_os_str()])?;
    crate::app_lifecycle::request_close(&app, &state, "update");
    Ok(())
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

    #[test]
    fn only_an_installed_bundle_can_update_itself() {
        let installed = std::path::Path::new("/Applications/Beads Station.app/Contents/MacOS/beads-station");
        assert_eq!(bundle_of(installed), Some(PathBuf::from("/Applications/Beads Station.app")));
        assert_eq!(bundle_of(std::path::Path::new("/repo/src-tauri/target/debug/beads-station")), None);
        assert_eq!(
            staged_bundle(std::path::Path::new("/Applications/Beads Station.app")),
            Some(PathBuf::from("/Applications/.Beads Station.app.update"))
        );
    }

    /// Run the real swap program against stand-in folders and a short-lived process.
    fn swap_fixture(name: &str) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("bs-update-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let bundle = root.join("Beads Station.app");
        let staged = staged_bundle(&bundle).unwrap();
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(bundle.join("version"), "old").unwrap();
        std::fs::write(staged.join("version"), "new").unwrap();
        let marker = root.join("relaunched");
        (root, bundle, staged, marker)
    }

    fn wait_for(path: &std::path::Path) -> bool {
        (0..100).any(|_| {
            std::thread::sleep(Duration::from_millis(50));
            path.exists()
        })
    }

    #[test]
    fn swap_waits_for_the_app_to_quit_then_replaces_it_and_relaunches() {
        let (root, bundle, staged, marker) = swap_fixture("swap");
        let mut app = Command::new("/bin/sleep").arg("1").spawn().unwrap();
        let touch = std::ffi::OsStr::new("/usr/bin/touch");
        spawn_swap(app.id(), &bundle, &staged, 30, &[touch, marker.as_os_str()]).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        // Still running: nothing has been touched.
        assert_eq!(std::fs::read_to_string(bundle.join("version")).unwrap(), "old");
        assert!(!marker.exists());
        app.wait().unwrap();
        assert!(wait_for(&marker), "relaunch command did not run");
        assert_eq!(std::fs::read_to_string(bundle.join("version")).unwrap(), "new");
        assert!(!staged.exists());
        assert!(!root.join("Beads Station.app.previous").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn swap_gives_up_and_leaves_the_app_alone_when_it_never_quits() {
        let (root, bundle, staged, marker) = swap_fixture("timeout");
        let mut app = Command::new("/bin/sleep").arg("3").spawn().unwrap();
        let touch = std::ffi::OsStr::new("/usr/bin/touch");
        spawn_swap(app.id(), &bundle, &staged, 1, &[touch, marker.as_os_str()]).unwrap();
        app.wait().unwrap();
        std::thread::sleep(Duration::from_millis(600));
        assert_eq!(std::fs::read_to_string(bundle.join("version")).unwrap(), "old");
        assert!(staged.exists(), "the prepared update is kept for a later restart");
        assert!(!marker.exists());
        let _ = std::fs::remove_dir_all(root);
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
