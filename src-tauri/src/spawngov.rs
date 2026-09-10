//! Separate lifetime budgets keep persistent agents from starving UI reads.
//! A permit covers the complete child lifetime, not merely the fork operation.
use once_cell::sync::Lazy;
use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

struct Pools {
    utilities: Arc<Semaphore>,
    agents: Arc<Semaphore>,
    terminals: Arc<Semaphore>,
}
impl Pools {
    fn new(utilities: usize, agents: usize, terminals: usize) -> Self {
        Self {
            utilities: Arc::new(Semaphore::new(utilities)),
            agents: Arc::new(Semaphore::new(agents)),
            terminals: Arc::new(Semaphore::new(terminals)),
        }
    }
}
fn limit(key: &str, fallback: usize, maximum: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(fallback)
        .min(maximum)
}
static POOLS: Lazy<Pools> = Lazy::new(|| {
    Pools::new(
        limit("BS_MAX_SPAWNS", 3, 16),
        limit("BS_MAX_AGENTS", 4, 32),
        limit("BS_MAX_TERMINALS", 16, 64),
    )
});

/// Short bd/git operations have reserved capacity even at the agent limit.
pub(crate) async fn permit() -> OwnedSemaphorePermit {
    POOLS
        .utilities
        .clone()
        .acquire_owned()
        .await
        .expect("utility pool is never closed")
}
/// Fail explicitly instead of leaving a UI invoke waiting behind long-lived chats.
pub(crate) fn agent_permit() -> Result<OwnedSemaphorePermit, String> {
    POOLS.agents.clone().try_acquire_owned().map_err(|_| {
        "Agent capacity reached. Stop an agent before starting another (BS_MAX_AGENTS).".into()
    })
}
pub(crate) fn terminal_permit() -> Result<OwnedSemaphorePermit, String> {
    POOLS.terminals.clone().try_acquire_owned().map_err(|_| {
        "Terminal capacity reached. Close a pane before opening another (BS_MAX_TERMINALS).".into()
    })
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
    fn configured_cap_has_a_floor_and_ceiling() {
        // Dedicated test variable avoids racing initialization of the live pools.
        const KEY: &str = "BS_TEST_CAP";
        std::env::remove_var(KEY);
        assert_eq!(limit(KEY, 3, 16), 3);
        for value in ["0", "invalid"] {
            std::env::set_var(KEY, value);
            assert_eq!(limit(KEY, 3, 16), 3);
        }
        std::env::set_var(KEY, "10");
        assert_eq!(limit(KEY, 3, 16), 10);
        std::env::set_var(KEY, "1000");
        assert_eq!(limit(KEY, 3, 16), 16);
        std::env::remove_var(KEY);
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
        let p3 = tokio::time::timeout(std::time::Duration::from_secs(1), permit())
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

#[cfg(test)]
mod capacity_tests {
    use super::*;
    #[tokio::test]
    async fn occupied_agent_and_terminal_slots_never_block_utility_reads() {
        let pools = Pools::new(2, 1, 1);
        let agent = pools.agents.clone().try_acquire_owned().unwrap();
        let terminal = pools.terminals.clone().try_acquire_owned().unwrap();
        assert!(pools.agents.clone().try_acquire_owned().is_err());
        assert!(pools.terminals.clone().try_acquire_owned().is_err());
        let read = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            pools.utilities.clone().acquire_owned(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(pools.utilities.available_permits(), 1);
        drop((agent, terminal, read));
        assert_eq!(pools.agents.available_permits(), 1);
        assert_eq!(pools.terminals.available_permits(), 1);
    }
}
