// Code-da0.5 — pluggable Designer conductor backends.
//
// A Designer ticket run can go straight to a provider CLI (`claude`, `codex`)
// or through a conductor that plans and delegates the work:
//
//   codex-orchestrator  The Codex adaptive orchestrator profile
//                       (github.com/Erscheinung/codex-astra-luna-orchestrator):
//                       a primary Sol agent owns scope and delegates bounded
//                       implementation to Luna workers. It runs as an ordinary
//                       `codex exec` child, so it inherits the native run's
//                       ownership, cancellation, artifact capture and approval.
//                       Available when `codex` is installed and the
//                       adaptive-orchestrator skill is present in the workspace
//                       (`.agents/skills/…`) or globally (`~/.codex/skills/…`).
//
//   opus-conductor      PLACEHOLDER. The Opus conductor lives in a private
//                       repository that is not part of this project. Detection
//                       only: set BS_OPUS_CONDUCTOR_DIR to a local checkout to
//                       have it reported as installed. It never launches until
//                       its launch contract is wired here.
//
// Detection is filesystem-only: no subprocess, no model call, no credential
// read. Launching happens only on an explicit Start in the Designer.

use std::path::{Path, PathBuf};

pub const CODEX_ORCHESTRATOR: &str = "codex-orchestrator";
pub const OPUS_CONDUCTOR: &str = "opus-conductor";

const ORCHESTRATOR_SKILL: &str = "skills/adaptive-orchestrator/SKILL.md";
pub const ORCHESTRATOR_SOURCE: &str = "https://github.com/Erscheinung/codex-astra-luna-orchestrator";

/// Locate the adaptive-orchestrator skill for `cwd`: the workspace-installed
/// profile wins over the global one, mirroring how Codex resolves skills.
pub fn orchestrator_skill(cwd: Option<&Path>, home: Option<&Path>, codex_home: Option<&Path>) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(cwd) = cwd {
        candidates.push(cwd.join(".agents").join(ORCHESTRATOR_SKILL));
    }
    if let Some(codex_home) = codex_home {
        candidates.push(codex_home.join(ORCHESTRATOR_SKILL));
    }
    if let Some(home) = home {
        candidates.push(home.join(".codex").join(ORCHESTRATOR_SKILL));
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).filter(|v| !v.is_empty()).map(PathBuf::from)
}

pub fn current_orchestrator_skill(cwd: Option<&Path>) -> Option<PathBuf> {
    orchestrator_skill(cwd, env_path("HOME").as_deref(), env_path("CODEX_HOME").as_deref())
}

/// The Opus conductor checkout, when the user has pointed at one.
pub fn opus_conductor_dir() -> Option<PathBuf> {
    env_path("BS_OPUS_CONDUCTOR_DIR").filter(|dir| dir.is_dir())
}

pub fn opus_placeholder_detail(dir: Option<&Path>) -> String {
    match dir {
        Some(dir) => format!(
            "Placeholder: checkout found at {}, but its launch contract is not wired yet",
            dir.display()
        ),
        None => "Placeholder: set BS_OPUS_CONDUCTOR_DIR to a local Opus conductor checkout".into(),
    }
}

/// Wrap a ticket prompt so the primary Codex agent routes through the
/// adaptive orchestrator instead of implementing everything itself.
pub fn orchestrator_prompt(ticket_prompt: &str) -> String {
    format!(
        "Use the adaptive-orchestrator skill for this ticket.\n\
         You are the primary agent: own scope, decisions, delegation and the final report.\n\
         Delegate routine implementation to one bounded worker with fork_turns=\"none\" and a \
         self-contained brief (outcome, files owned, constraints, acceptance criteria, focused checks). \
         Add a second worker only for independent, non-overlapping work. Do not spawn a reviewer.\n\
         Finish with: changed files, checks actually run and their results, and remaining limitations.\n\n\
         --- Ticket ---\n{ticket_prompt}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bs-conductors-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn install_skill(root: &Path) -> PathBuf {
        let skill = root.join(ORCHESTRATOR_SKILL);
        std::fs::create_dir_all(skill.parent().unwrap()).unwrap();
        std::fs::write(&skill, "# skill").unwrap();
        skill
    }

    #[test]
    fn workspace_skill_wins_over_global() {
        let workspace = temp_dir("ws");
        let home = temp_dir("home");
        let global = install_skill(&home.join(".codex"));
        assert_eq!(orchestrator_skill(Some(&workspace), Some(&home), None), Some(global));
        let local = install_skill(&workspace.join(".agents"));
        assert_eq!(orchestrator_skill(Some(&workspace), Some(&home), None), Some(local));
    }

    #[test]
    fn missing_skill_is_unavailable() {
        let empty = temp_dir("empty");
        assert_eq!(orchestrator_skill(Some(&empty), Some(&empty), Some(&empty)), None);
    }

    #[test]
    fn prompt_keeps_ticket_and_forbids_reviewer() {
        let wrapped = orchestrator_prompt("Work on ticket Code-1");
        assert!(wrapped.contains("adaptive-orchestrator"));
        assert!(wrapped.contains("Do not spawn a reviewer"));
        assert!(wrapped.ends_with("Work on ticket Code-1"));
    }

    #[test]
    fn opus_placeholder_never_claims_launchable() {
        assert!(opus_placeholder_detail(None).starts_with("Placeholder"));
        assert!(opus_placeholder_detail(Some(Path::new("/x"))).contains("not wired"));
    }
}
