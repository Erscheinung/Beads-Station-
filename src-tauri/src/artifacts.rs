//! Designer artifact capture and approval ledger.
//!
//! Capture is explicit and local: it reads the workspace (or its git status),
//! never trusts provider output, and stores bounded immutable revisions in the
//! app-data directory. Approval only records an exact revision identity; it
//! does not publish, merge, post, or invoke a model.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use uuid::Uuid;

const SCHEMA_VERSION: u32 = 1;
const MAX_FILES: usize = 256;
const MAX_FILE_BYTES: usize = 256 * 1024;
const MAX_TOTAL_BYTES: usize = 4 * 1024 * 1024;
const MAX_DIFF_BYTES: usize = 512 * 1024;
const MAX_STATUS_BYTES: usize = 2 * 1024 * 1024;
const MAX_PATH_BYTES: usize = 1024;
static LEDGER_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactFile {
    pub path: String,
    pub status: String,
    pub size: u64,
    pub content_hash: String,
    pub content: Option<String>,
    pub binary: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRevision {
    pub schema_version: u32,
    pub revision_id: String,
    pub captured_at: u64,
    pub workspace_id: String,
    pub ticket_id: String,
    pub run_id: String,
    pub attempt_id: String,
    pub workspace_path: String,
    #[serde(default)]
    pub source_revision: Option<String>,
    pub revision_hash: String,
    pub files: Vec<ArtifactFile>,
    pub diff: Option<String>,
    pub validation: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ArtifactLedger {
    schema_version: u32,
    revisions: Vec<ArtifactRevision>,
    approvals: Vec<ArtifactApproval>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactApproval {
    pub workspace_id: String,
    pub ticket_id: String,
    pub run_id: String,
    pub attempt_id: String,
    pub revision_id: String,
    pub revision_hash: String,
    pub approved_at: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureArgs {
    pub workspace_id: String,
    pub ticket_id: String,
    pub run_id: String,
    pub attempt_id: String,
    pub workspace_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyArgs {
    pub revision: ArtifactRevisionRef,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveArgs {
    pub revision: ArtifactRevisionRef,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRevisionRef {
    pub workspace_id: String,
    pub ticket_id: String,
    pub run_id: String,
    pub attempt_id: String,
    pub revision_id: String,
    pub revision_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewArgs {
    pub workspace_id: String,
    pub ticket_id: String,
    pub run_id: String,
    pub attempt_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactReviewSnapshot {
    revision: Option<ArtifactRevision>,
    approval: Option<ArtifactApproval>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn validate_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 256 || value.chars().any(|c| c.is_control()) {
        return Err(format!("invalid {label}"));
    }
    Ok(())
}

fn hash_bytes(bytes: &[u8]) -> String {
    // UUID v5 is backed by SHA-1 and is already a direct dependency through
    // the project's uuid crate. It gives us a stable content identity without
    // adding another hashing dependency or changing the lockfile.
    Uuid::new_v5(&Uuid::NAMESPACE_OID, bytes).to_string()
}

fn canonical_workspace(raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err("workspace path must be absolute".into());
    }
    let root = fs::canonicalize(&path).map_err(|e| format!("workspace path: {e}"))?;
    if !root.is_dir() {
        return Err("workspace path is not a directory".into());
    }
    Ok(root)
}

fn safe_relative(root: &Path, raw: &Path) -> Result<Option<PathBuf>, String> {
    if raw.as_os_str().len() > MAX_PATH_BYTES {
        return Ok(None);
    }
    let metadata = match fs::symlink_metadata(raw) {
        Ok(metadata) => metadata,
        Err(_) => return Ok(None),
    };
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "changed symlink cannot be captured safely: {}",
            raw.display()
        ));
    }
    let canonical = match fs::canonicalize(raw) {
        Ok(path) => path,
        Err(_) => return Ok(None),
    };
    if !canonical.starts_with(root) {
        return Err(format!(
            "artifact path escapes workspace: {}",
            raw.display()
        ));
    }
    let relative = canonical
        .strip_prefix(root)
        .map_err(|_| "artifact path is outside workspace".to_string())?;
    if relative
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("artifact path contains traversal".into());
    }
    if relative.as_os_str().is_empty()
        || relative.components().any(
            |component| matches!(component, std::path::Component::Normal(name) if name == ".git"),
        )
    {
        return Ok(None);
    }
    Ok(Some(relative.to_path_buf()))
}

fn git_changed(root: &Path) -> Result<Option<Vec<(String, PathBuf)>>, String> {
    let Ok(git) = crate::binresolve::resolve_bin("git") else {
        return Ok(None);
    };
    let mut child = Command::new(git)
        .current_dir(root)
        .args(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("read git status: {error}"))?;
    let mut output = Vec::new();
    child
        .stdout
        .take()
        .ok_or_else(|| "git status stdout was not captured".to_string())?
        .take((MAX_STATUS_BYTES + 1) as u64)
        .read_to_end(&mut output)
        .map_err(|error| format!("read git status: {error}"))?;
    if output.len() > MAX_STATUS_BYTES {
        let _ = child.kill();
        let _ = child.wait();
        return Err("git status exceeds the bounded artifact limit".into());
    }
    let status = child
        .wait()
        .map_err(|error| format!("wait for git status: {error}"))?;
    if !status.success() {
        return Ok(None);
    }
    Ok(Some(parse_git_changed(root, &output)))
}

fn parse_git_changed(root: &Path, output: &[u8]) -> Vec<(String, PathBuf)> {
    let mut result = Vec::new();
    let mut chunks = output.split(|byte| *byte == 0);
    while let Some(chunk) = chunks.next() {
        if chunk.len() < 4 {
            continue;
        }
        let status = String::from_utf8_lossy(&chunk[..2]).trim().to_string();
        let path = String::from_utf8_lossy(&chunk[3..]).to_string();
        // Porcelain v1 -z emits `XY destination\0source\0`. Consume the
        // source field, but capture the destination that now exists.
        if status.starts_with('R') || status.starts_with('C') {
            let _ = chunks.next();
        }
        if !path.is_empty() {
            result.push((status, root.join(path)));
        }
    }
    result
}

fn walk_workspace(root: &Path, out: &mut Vec<(String, PathBuf)>, depth: usize) {
    // Retain one overflow sentinel so capture fails instead of silently
    // approving an incomplete manifest.
    if out.len() > MAX_FILES || depth > 8 {
        return;
    }
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if out.len() > MAX_FILES {
            break;
        }
        let path = entry.path();
        if path.file_name().is_some_and(|name| name == ".git") {
            continue;
        }
        let metadata = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            walk_workspace(&path, out, depth + 1);
        } else if metadata.is_file() {
            out.push(("A".into(), path));
        }
    }
}

fn read_file(
    root: &Path,
    status: String,
    path: PathBuf,
    total: &mut usize,
) -> Result<Option<ArtifactFile>, String> {
    let deleted = status.contains('D') && !path.exists();
    let relative = if deleted {
        // A deleted git path no longer has metadata to canonicalize. It is
        // still safe to include when the lexical path is rooted in the
        // canonical workspace and contains no traversal component.
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "deleted artifact path is outside workspace".to_string())?;
        if relative.as_os_str().is_empty() || relative.components().any(|component| matches!(component, std::path::Component::ParentDir)) || relative.components().any(|component| matches!(component, std::path::Component::Normal(name) if name == ".git")) {
            return Ok(None);
        }
        relative.to_path_buf()
    } else {
        let Some(relative) = safe_relative(root, &path)? else {
            return Ok(None);
        };
        relative
    };
    if deleted {
        return Ok(Some(ArtifactFile {
            path: relative.to_string_lossy().into_owned(),
            status,
            size: 0,
            content_hash: hash_bytes(relative.to_string_lossy().as_bytes()),
            content: None,
            binary: false,
            truncated: false,
        }));
    }
    let metadata = fs::metadata(&path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    let size = metadata.len();
    if size > MAX_FILE_BYTES as u64 || total.saturating_add(size as usize) > MAX_TOTAL_BYTES {
        return Err(format!(
            "artifact content exceeds the bounded capture limit: {}",
            relative.display()
        ));
    }
    let bytes = fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    *total = total.saturating_add(bytes.len());
    let content = String::from_utf8(bytes.clone()).map_err(|_| {
        format!(
            "binary artifact is not supported by the safe text preview: {}",
            relative.display()
        )
    })?;
    let mut identity = relative.to_string_lossy().as_bytes().to_vec();
    identity.extend_from_slice(&bytes);
    Ok(Some(ArtifactFile {
        path: relative.to_string_lossy().into_owned(),
        status: if status.is_empty() {
            "A".into()
        } else {
            status
        },
        size,
        content_hash: hash_bytes(&identity),
        content: Some(content),
        binary: false,
        truncated: false,
    }))
}

fn capture_inner(args: &CaptureArgs) -> Result<ArtifactRevision, String> {
    for (value, label) in [
        (&args.workspace_id, "workspace_id"),
        (&args.ticket_id, "ticket_id"),
        (&args.run_id, "run_id"),
        (&args.attempt_id, "attempt_id"),
    ] {
        validate_id(value, label)?;
    }
    let root = canonical_workspace(&args.workspace_path)?;
    let git_candidates = git_changed(&root)?;
    let mut candidates = git_candidates.clone().unwrap_or_default();
    if git_candidates.is_none() {
        walk_workspace(&root, &mut candidates, 0);
    }
    candidates.sort_by(|a, b| a.1.cmp(&b.1));
    candidates.dedup_by(|a, b| a.1 == b.1);
    if candidates.len() > MAX_FILES {
        return Err(format!(
            "artifact has more than the supported {MAX_FILES} changed files"
        ));
    }
    let mut files = Vec::new();
    let mut total = 0usize;
    for (status, path) in candidates {
        if let Some(file) = read_file(&root, status, path, &mut total)? {
            files.push(file);
        }
    }
    let source_revision = git_source_revision(&root);
    let manifest = files
        .iter()
        .map(|file| format!("{}\0{}\0{}", file.status, file.path, file.content_hash))
        .collect::<Vec<_>>()
        .join("\0");
    let manifest = format!(
        "{}\0{manifest}",
        source_revision.as_deref().unwrap_or("non-git")
    );
    let revision_hash = hash_bytes(manifest.as_bytes());
    let revision_id = format!("rev-{revision_hash}-{}", now_ms());
    let diff = git_diff(&root);
    Ok(ArtifactRevision {
        schema_version: SCHEMA_VERSION,
        revision_id,
        captured_at: now_ms(),
        workspace_id: args.workspace_id.clone(),
        ticket_id: args.ticket_id.clone(),
        run_id: args.run_id.clone(),
        attempt_id: args.attempt_id.clone(),
        workspace_path: root.to_string_lossy().into_owned(),
        source_revision,
        revision_hash,
        files,
        diff,
        validation: Vec::new(),
    })
}

async fn capture_off_thread(args: CaptureArgs) -> Result<ArtifactRevision, String> {
    tokio::task::spawn_blocking(move || capture_inner(&args))
        .await
        .map_err(|error| format!("artifact capture task failed: {error}"))?
}

fn git_source_revision(root: &Path) -> Option<String> {
    let git = crate::binresolve::resolve_bin("git").ok()?;
    let output = Command::new(git)
        .current_dir(root)
        .args(["rev-parse", "--verify", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let revision = String::from_utf8(output.stdout).ok()?;
    let revision = revision.trim();
    (!revision.is_empty()).then(|| revision.to_string())
}

fn git_diff(root: &Path) -> Option<String> {
    let git = crate::binresolve::resolve_bin("git").ok()?;
    let mut child = Command::new(git)
        .current_dir(root)
        .args([
            "diff",
            "HEAD",
            "--no-ext-diff",
            "--no-color",
            "--unified=40",
            "--",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut bytes = Vec::new();
    child
        .stdout
        .take()?
        .take((MAX_DIFF_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    let truncated = bytes.len() > MAX_DIFF_BYTES;
    if truncated {
        bytes.truncate(MAX_DIFF_BYTES);
        let _ = child.kill();
    }
    let status = child.wait().ok()?;
    if !truncated && !status.success() {
        return None;
    }
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if truncated {
        text.push_str("\n… diff truncated …");
    }
    (!text.is_empty()).then_some(text)
}

fn ledger_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data directory: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create app data directory: {e}"))?;
    Ok(dir.join("designer-artifacts.v1.json"))
}

fn read_ledger(app: &tauri::AppHandle) -> Result<ArtifactLedger, String> {
    let path = ledger_path(app)?;
    if !path.exists() {
        return Ok(ArtifactLedger {
            schema_version: SCHEMA_VERSION,
            ..Default::default()
        });
    }
    let value = fs::read_to_string(path).map_err(|e| format!("read artifact ledger: {e}"))?;
    let ledger: ArtifactLedger =
        serde_json::from_str(&value).map_err(|e| format!("artifact ledger is invalid: {e}"))?;
    if ledger.schema_version != 0 && ledger.schema_version != SCHEMA_VERSION {
        return Err("unsupported artifact ledger schema".into());
    }
    Ok(ledger)
}

fn write_ledger(app: &tauri::AppHandle, ledger: &ArtifactLedger) -> Result<(), String> {
    let path = ledger_path(app)?;
    let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let value =
        serde_json::to_vec_pretty(ledger).map_err(|e| format!("serialize artifact ledger: {e}"))?;
    fs::write(&temp, value).map_err(|e| format!("write artifact ledger: {e}"))?;
    fs::rename(&temp, &path).map_err(|e| format!("commit artifact ledger: {e}"))?;
    Ok(())
}

fn keep_newest<T>(items: &mut Vec<T>, limit: usize) {
    if items.len() > limit {
        items.drain(..items.len() - limit);
    }
}

fn stored_revision(
    ledger: &ArtifactLedger,
    reference: &ArtifactRevisionRef,
) -> Result<ArtifactRevision, String> {
    for (value, label) in [
        (&reference.workspace_id, "workspace_id"),
        (&reference.ticket_id, "ticket_id"),
        (&reference.run_id, "run_id"),
        (&reference.attempt_id, "attempt_id"),
        (&reference.revision_id, "revision_id"),
        (&reference.revision_hash, "revision_hash"),
    ] {
        validate_id(value, label)?;
    }
    ledger
        .revisions
        .iter()
        .find(|revision| {
            revision.workspace_id == reference.workspace_id
                && revision.ticket_id == reference.ticket_id
                && revision.run_id == reference.run_id
                && revision.attempt_id == reference.attempt_id
                && revision.revision_id == reference.revision_id
                && revision.revision_hash == reference.revision_hash
        })
        .cloned()
        .ok_or_else(|| "artifact revision is not stored with this exact identity".to_string())
}

#[tauri::command]
pub async fn artifact_review(
    app: tauri::AppHandle,
    args: ReviewArgs,
) -> Result<ArtifactReviewSnapshot, String> {
    for (value, label) in [
        (&args.workspace_id, "workspace_id"),
        (&args.ticket_id, "ticket_id"),
        (&args.run_id, "run_id"),
        (&args.attempt_id, "attempt_id"),
    ] {
        validate_id(value, label)?;
    }
    tokio::task::spawn_blocking(move || {
        let _ledger_guard = LEDGER_LOCK
            .lock()
            .map_err(|_| "artifact ledger lock is unavailable".to_string())?;
        let ledger = read_ledger(&app)?;
        let revision = ledger
            .revisions
            .iter()
            .rev()
            .find(|revision| {
                revision.workspace_id == args.workspace_id
                    && revision.ticket_id == args.ticket_id
                    && revision.run_id == args.run_id
                    && revision.attempt_id == args.attempt_id
            })
            .cloned();
        let approval = revision.as_ref().and_then(|revision| {
            ledger
                .approvals
                .iter()
                .rev()
                .find(|approval| {
                    approval.workspace_id == revision.workspace_id
                        && approval.ticket_id == revision.ticket_id
                        && approval.run_id == revision.run_id
                        && approval.attempt_id == revision.attempt_id
                        && approval.revision_id == revision.revision_id
                        && approval.revision_hash == revision.revision_hash
                })
                .cloned()
        });
        Ok(ArtifactReviewSnapshot { revision, approval })
    })
    .await
    .map_err(|error| format!("artifact review task failed: {error}"))?
}

#[tauri::command]
pub async fn artifact_capture(
    app: tauri::AppHandle,
    args: CaptureArgs,
) -> Result<ArtifactRevision, String> {
    let _review_guard = crate::claude::lock_native_review_action().await;
    let root = canonical_workspace(&args.workspace_path)?;
    crate::claude::ensure_native_run_reviewable(
        &args.workspace_id,
        &args.ticket_id,
        &args.run_id,
        &args.attempt_id,
        &root,
    )
    .await?;
    let revision = capture_off_thread(args).await?;
    let _ledger_guard = LEDGER_LOCK
        .lock()
        .map_err(|_| "artifact ledger lock is unavailable".to_string())?;
    let mut ledger = read_ledger(&app)?;
    ledger.schema_version = SCHEMA_VERSION;
    ledger
        .revisions
        .retain(|old| old.revision_id != revision.revision_id);
    ledger.revisions.push(revision.clone());
    keep_newest(&mut ledger.revisions, 50);
    write_ledger(&app, &ledger)?;
    Ok(revision)
}

#[tauri::command]
pub async fn artifact_verify(app: tauri::AppHandle, args: VerifyArgs) -> Result<bool, String> {
    let revision = {
        let _ledger_guard = LEDGER_LOCK
            .lock()
            .map_err(|_| "artifact ledger lock is unavailable".to_string())?;
        stored_revision(&read_ledger(&app)?, &args.revision)?
    };
    let capture = capture_off_thread(CaptureArgs {
        workspace_id: revision.workspace_id,
        ticket_id: revision.ticket_id,
        run_id: revision.run_id,
        attempt_id: revision.attempt_id,
        workspace_path: revision.workspace_path,
    })
    .await?;
    Ok(capture.revision_hash == args.revision.revision_hash)
}

#[tauri::command]
pub async fn artifact_approve(
    app: tauri::AppHandle,
    args: ApproveArgs,
) -> Result<ArtifactApproval, String> {
    let _review_guard = crate::claude::lock_native_review_action().await;
    let revision = {
        let _ledger_guard = LEDGER_LOCK
            .lock()
            .map_err(|_| "artifact ledger lock is unavailable".to_string())?;
        stored_revision(&read_ledger(&app)?, &args.revision)?
    };
    let root = canonical_workspace(&revision.workspace_path)?;
    crate::claude::ensure_native_run_reviewable(
        &revision.workspace_id,
        &revision.ticket_id,
        &revision.run_id,
        &revision.attempt_id,
        &root,
    )
    .await?;
    let current = capture_off_thread(CaptureArgs {
        workspace_id: revision.workspace_id.clone(),
        ticket_id: revision.ticket_id.clone(),
        run_id: revision.run_id.clone(),
        attempt_id: revision.attempt_id.clone(),
        workspace_path: revision.workspace_path.clone(),
    })
    .await?;
    if current.revision_hash != revision.revision_hash {
        return Err("workspace changed after artifact capture".into());
    }
    let approval = ArtifactApproval {
        workspace_id: revision.workspace_id.clone(),
        ticket_id: revision.ticket_id.clone(),
        run_id: revision.run_id.clone(),
        attempt_id: revision.attempt_id.clone(),
        revision_id: revision.revision_id.clone(),
        revision_hash: revision.revision_hash.clone(),
        approved_at: now_ms(),
    };
    let _ledger_guard = LEDGER_LOCK
        .lock()
        .map_err(|_| "artifact ledger lock is unavailable".to_string())?;
    let mut ledger = read_ledger(&app)?;
    let still_stored = ledger.revisions.iter().any(|stored| {
        stored.revision_id == revision.revision_id
            && stored.revision_hash == revision.revision_hash
            && stored.run_id == revision.run_id
            && stored.attempt_id == revision.attempt_id
    });
    if !still_stored {
        return Err("artifact revision changed during approval".into());
    }
    ledger.approvals.retain(|old| {
        old.workspace_id != approval.workspace_id || old.ticket_id != approval.ticket_id
    });
    ledger.approvals.push(approval.clone());
    keep_newest(&mut ledger.approvals, 50);
    write_ledger(&app, &ledger)?;
    Ok(approval)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn hash_is_stable() {
        assert_eq!(hash_bytes(b"beads"), hash_bytes(b"beads"));
    }

    #[test]
    fn bounded_ledgers_keep_the_newest_records() {
        let mut values = vec![1, 2, 3, 4];
        keep_newest(&mut values, 2);
        assert_eq!(values, vec![3, 4]);
    }

    #[test]
    fn symlinks_are_not_captured() {
        let root = std::env::temp_dir().join(format!("bs-artifacts-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let outside = root.with_extension("outside");
        let mut file = fs::File::create(&outside).unwrap();
        file.write_all(b"outside").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("escape.txt")).unwrap();
        let mut files = Vec::new();
        walk_workspace(&root, &mut files, 0);
        assert!(files
            .iter()
            .all(|(_, path)| path.file_name().is_none_or(|name| name != "escape.txt")));
        #[cfg(unix)]
        {
            let mut total = 0;
            assert!(
                read_file(&root, "M".into(), root.join("escape.txt"), &mut total,)
                    .unwrap_err()
                    .contains("symlink")
            );
        }
        let _ = fs::remove_file(outside);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn captures_bounded_fixture_files_without_provider_output() {
        let root =
            std::env::temp_dir().join(format!("bs-artifacts-fixture-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("index.html"), b"<main>fixture</main>").unwrap();
        let revision = capture_inner(&CaptureArgs {
            workspace_id: "fixture-workspace".into(),
            ticket_id: "Code-game".into(),
            run_id: "run-1".into(),
            attempt_id: "attempt-1".into(),
            workspace_path: root.to_string_lossy().into_owned(),
        })
        .unwrap();
        assert_eq!(revision.files.len(), 1);
        assert_eq!(revision.files[0].path, "index.html");
        assert!(revision.validation.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rename_status_captures_the_destination_path() {
        let root = Path::new("/tmp/workspace");
        let changed = parse_git_changed(root, b"R  renamed.txt\0old.txt\0");
        assert_eq!(changed, vec![("R".into(), root.join("renamed.txt"))]);
    }

    #[test]
    fn rejects_oversized_content_instead_of_approving_an_unfrozen_preview() {
        let root =
            std::env::temp_dir().join(format!("bs-artifacts-large-fixture-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("large.txt");
        let mut content = vec![b'a'; MAX_FILE_BYTES + 16];
        fs::write(&path, &content).unwrap();
        let args = CaptureArgs {
            workspace_id: "fixture-workspace".into(),
            ticket_id: "Code-large".into(),
            run_id: "run-large".into(),
            attempt_id: "attempt-large".into(),
            workspace_path: root.to_string_lossy().into_owned(),
        };
        assert!(capture_inner(&args)
            .unwrap_err()
            .contains("bounded capture limit"));
        content.truncate(MAX_FILE_BYTES);
        fs::write(&path, &content).unwrap();
        let first = capture_inner(&args).unwrap();
        content[MAX_FILE_BYTES - 1] = b'b';
        fs::write(&path, &content).unwrap();
        let second = capture_inner(&args).unwrap();
        assert_ne!(first.revision_hash, second.revision_hash);
        let _ = fs::remove_dir_all(root);
    }
}
