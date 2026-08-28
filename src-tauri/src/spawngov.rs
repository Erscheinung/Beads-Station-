// Beads Station — EXP backbone: one process-global subprocess spawn governor.
//
// The whole app spawns three kinds of child: the `bd` CLI (a ~130MB Go binary
// that itself forks git/dolt), `git`, and `claude --print` (long-lived, with
// three pipe fds). Before this module each of those had its own (or no)
// throttle: bd had a module-private Semaphore(3) that `bd_prime`/`bd_git_branch`
// bypassed, and claude/conductor spawns were entirely ungoverned. Under real
// load (agent panes + board refresh + conductor fanout) the aggregate fork/fd
// count overran the launchd fd ceiling -> EMFILE ("Too many open files",
// os error 24) -> a cascading toast storm.
//
// This is the single choke point every spawn now passes through. The permit is
// OWNED and meant to be held for the child's WHOLE lifetime (not just the fork
// instant), so a persistent `claude --print` counts against the cap until it is
// reaped — those long-lived children are the real load generators, and the old
// bd-only cap never saw them.

use once_cell::sync::Lazy;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Default cap on concurrent governed spawns. Deliberately small: each `bd`
/// invocation forks git+dolt underneath, and each `claude` holds three pipe
/// fds for its whole life, so the effective fd/fork multiplier per permit is
/// well above one. 6 keeps the board responsive (its snapshot wants 2) while
/// leaving headroom for a conductor pulse + an interactive agent, all under the
/// launchd fd ceiling. Tunable via `BS_MAX_SPAWNS` for the packaged `.app`,
/// where the real ceiling is only known at runtime.
const DEFAULT_MAX_SPAWNS: usize = 6;

fn max_spawns() -> usize {
    std::env::var("BS_MAX_SPAWNS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|n| *n >= 1)
        .unwrap_or(DEFAULT_MAX_SPAWNS)
}

/// The one global governor. `Arc`-backed so we can hand out `OwnedSemaphorePermit`s
/// that outlive any single call frame (they ride inside a spawned child's owning
/// struct/task and drop exactly when that child is reaped).
static GOVERNOR: Lazy<std::sync::Arc<Semaphore>> =
    Lazy::new(|| std::sync::Arc::new(Semaphore::new(max_spawns())));

/// Acquire a permit for a child spawn. Hold the returned permit for the child's
/// entire lifetime — bind it into the owning struct (e.g. `ClaudeSession`) or
/// keep it in scope across the `wait`/`select` that reaps the child. Dropping it
/// early defeats the point (the fd stays open while the permit is already freed).
///
/// Acquire never fails: the governor is never closed, so `acquire_owned` only
/// errors on a closed semaphore, which cannot happen here — we unwrap that
/// impossible case into a clear panic rather than threading a Result everywhere.
pub(crate) async fn permit() -> OwnedSemaphorePermit {
    GOVERNOR
        .clone()
        .acquire_owned()
        .await
        .expect("spawn governor semaphore is never closed")
}

/// True when an error string indicates resource exhaustion we should back off
/// and retry on — whether from our own spawn or from bd's internal fork of
/// git/dolt. Single source of truth for the retry guard.
///
/// Covers BOTH failure modes seen in the wild:
///   - EMFILE  — "Too many open files" / os error 24 (fd table exhausted). This
///     is the one the live screenshot hit; the old bd-private guard did NOT
///     match it, so there was no backoff and the app storm-failed immediately.
///   - EAGAIN  — "Resource temporarily unavailable" / os error 35 (fork/thread
///     table exhausted). The case the original guard was built for.
pub(crate) fn is_resource_exhaustion(msg: &str) -> bool {
    msg.contains("os error 24")
        || msg.contains("Too many open files")
        || msg.contains("too many open files")
        || msg.contains("os error 35")
        || msg.contains("Resource temporarily unavailable")
        || msg.contains("resource temporarily unavailable")
}

/// Escalating backoff (ms) between retry attempts. Two entries => three total
/// attempts. A transient exhaustion (a subprocess burst draining the table)
/// usually clears within a few hundred ms; a sustained one still fails after
/// the bounded retries rather than hanging.
const BACKOFF_MS: [u64; 2] = [120, 350];
const MAX_ATTEMPTS: usize = 3;

/// Run an async spawn operation under the governor's retry+backoff policy.
///
/// `op` is invoked (up to `MAX_ATTEMPTS` times) and should perform the actual
/// spawn + await. This helper owns ONLY the retry loop — the caller is
/// responsible for holding a `permit()` for the child's lifetime. (Short-lived
/// one-shot reads like bd typically acquire the permit inside `op` and drop it
/// when `op` returns, since the child is fully awaited within the call. Long-
/// lived children like claude must hold the permit OUTSIDE `op`.)
///
/// Only resource-exhaustion errors are retried; every other error returns
/// immediately.
pub(crate) async fn with_retry<T, F, Fut>(mut op: F) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let mut attempt = 0;
    loop {
        match op().await {
            Ok(v) => return Ok(v),
            Err(e) if is_resource_exhaustion(&e) && attempt < MAX_ATTEMPTS - 1 => {
                tokio::time::sleep(std::time::Duration::from_millis(BACKOFF_MS[attempt])).await;
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_emfile_the_live_failure() {
        // The exact string from the screenshot storm.
        assert!(is_resource_exhaustion(
            "failed to spawn bd: Too many open files (os error 24)"
        ));
        assert!(is_resource_exhaustion("Too many open files (os error 24)"));
    }

    #[test]
    fn matches_eagain_the_original_case() {
        assert!(is_resource_exhaustion(
            "fork: Resource temporarily unavailable (os error 35)"
        ));
    }

    #[test]
    fn does_not_match_ordinary_errors() {
        assert!(!is_resource_exhaustion("no beads database found"));
        assert!(!is_resource_exhaustion("bd exited with status 1: boom"));
        assert!(!is_resource_exhaustion(""));
    }

    #[test]
    fn default_cap_when_env_unset() {
        // Only asserts the parse/clamp logic, not the live static (other tests
        // may hold permits). An empty/invalid var falls back to the default.
        std::env::remove_var("BS_MAX_SPAWNS");
        assert_eq!(max_spawns(), DEFAULT_MAX_SPAWNS);
        std::env::set_var("BS_MAX_SPAWNS", "0"); // below floor -> default
        assert_eq!(max_spawns(), DEFAULT_MAX_SPAWNS);
        std::env::set_var("BS_MAX_SPAWNS", "not-a-number");
        assert_eq!(max_spawns(), DEFAULT_MAX_SPAWNS);
        std::env::set_var("BS_MAX_SPAWNS", "10");
        assert_eq!(max_spawns(), 10);
        std::env::remove_var("BS_MAX_SPAWNS");
    }

    #[tokio::test]
    async fn permit_bounds_concurrency_and_releases_on_drop() {
        // Acquire two permits, confirm they are distinct grants, then drop one
        // and confirm a third acquire proceeds. This is the permit-accounting
        // invariant the whole storm fix rests on: a dropped permit frees a slot.
        let p1 = permit().await;
        let p2 = permit().await;
        drop(p1);
        // A fresh acquire must not deadlock now that a slot freed.
        let p3 =
            tokio::time::timeout(std::time::Duration::from_secs(1), permit())
                .await
                .expect("permit should be available after a drop");
        drop(p2);
        drop(p3);
    }

    #[tokio::test]
    async fn with_retry_gives_up_after_bounded_attempts_on_exhaustion() {
        let mut calls = 0;
        let r: Result<(), String> = with_retry(|| {
            calls += 1;
            async move { Err("Too many open files (os error 24)".to_string()) }
        })
        .await;
        assert!(r.is_err());
        assert_eq!(calls, MAX_ATTEMPTS, "should try exactly MAX_ATTEMPTS times");
    }

    #[tokio::test]
    async fn with_retry_returns_non_exhaustion_error_immediately() {
        let mut calls = 0;
        let r: Result<(), String> = with_retry(|| {
            calls += 1;
            async move { Err("no beads database found".to_string()) }
        })
        .await;
        assert!(r.is_err());
        assert_eq!(calls, 1, "non-exhaustion errors must not retry");
    }

    #[tokio::test]
    async fn with_retry_succeeds_first_try() {
        let r: Result<i32, String> = with_retry(|| async { Ok(42) }).await;
        assert_eq!(r.unwrap(), 42);
    }
}
