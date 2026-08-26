import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// RV3.3 (Code-1t8) — shared bd snapshot cache.
//
// The cache collapses the previous per-component bd fan-out (Board bdReady+
// bdList, IssueList bdList, Statusline bd_counts) into ONE deduped bd_snapshot
// fetch per repoPath. Two behaviors are load-bearing and unit-testable without
// a real Tauri backend:
//
//   1. In-flight dedup — N concurrent fetchSnapshot() calls for one repoPath
//      issue exactly ONE bdSnapshot() invoke; all share the same promise.
//   2. Transient-empty self-heal — a settled EMPTY snapshot (no error)
//      schedules exactly one retry after SELF_HEAL_MS; a non-empty result does
//      NOT. This is the RV3.2 anti-latch, moved out of Board/IssueList into the
//      cache so both share it.
//
// We mock the bd_snapshot fetch seam (types/issue.bdSnapshot) and the
// BdLiveProvider import (bdCache pulls in useBdLiveContext, whose transitive
// safeListen import touches the Tauri event API).
// ---------------------------------------------------------------------------

const snapshotMock = vi.fn()

vi.mock('../types/issue', () => ({
  bdSnapshot: (...args: unknown[]) => snapshotMock(...args),
}))

vi.mock('./BdLiveProvider', () => ({
  useBdLiveContext: () => {},
}))

import { fetchSnapshot, __resetBdCacheForTest, __subscribeForTest, __getSnapshotForTest } from './bdCache'

const REPO = '/repo/a'

describe('bdCache — RV3.3 shared snapshot', () => {
  beforeEach(() => {
    __resetBdCacheForTest()
    snapshotMock.mockReset()
    vi.useRealTimers()
  })
  afterEach(() => {
    __resetBdCacheForTest()
    vi.useRealTimers()
  })

  it('dedups concurrent fetches into ONE backend call', async () => {
    let resolve!: (v: { ready: unknown[]; all: unknown[]; no_db: boolean }) => void
    snapshotMock.mockImplementation(
      () => new Promise(r => { resolve = r as typeof resolve }),
    )

    // Three simultaneous consumers ask before the first settles.
    const p1 = fetchSnapshot(REPO)
    const p2 = fetchSnapshot(REPO)
    const p3 = fetchSnapshot(REPO)

    expect(snapshotMock).toHaveBeenCalledTimes(1) // dedup guard
    expect(p1).toBe(p2)
    expect(p2).toBe(p3)

    resolve({ ready: [{ id: 'A' }], all: [{ id: 'A' }], no_db: false })
    await Promise.all([p1, p2, p3])

    // A fresh fetch after settle issues a new call (inFlight cleared).
    snapshotMock.mockResolvedValueOnce({ ready: [], all: [{ id: 'A' }], no_db: false })
    await fetchSnapshot(REPO)
    expect(snapshotMock).toHaveBeenCalledTimes(2)
  })

  it('schedules exactly one self-heal retry on a settled empty snapshot', async () => {
    vi.useFakeTimers()
    snapshotMock.mockResolvedValue({ ready: [], all: [], no_db: false })

    await fetchSnapshot(REPO)
    expect(snapshotMock).toHaveBeenCalledTimes(1)

    // Before the heal window: no extra call.
    vi.advanceTimersByTime(3999)
    expect(snapshotMock).toHaveBeenCalledTimes(1)

    // At SELF_HEAL_MS (4000): exactly one retry fires.
    vi.advanceTimersByTime(1)
    expect(snapshotMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT schedule a retry when the snapshot is non-empty', async () => {
    vi.useFakeTimers()
    snapshotMock.mockResolvedValue({ ready: [{ id: 'A' }], all: [{ id: 'A' }], no_db: false })

    await fetchSnapshot(REPO)
    expect(snapshotMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(10_000)
    expect(snapshotMock).toHaveBeenCalledTimes(1) // no self-heal for non-empty
  })

  it('caps the transient-empty self-heal loop on a persistently-empty repo (Code-o40.5)', async () => {
    vi.useFakeTimers()
    // Every read settles empty (a legitimately-empty real repo).
    snapshotMock.mockResolvedValue({ ready: [], all: [], no_db: false })

    await fetchSnapshot(REPO)
    expect(snapshotMock).toHaveBeenCalledTimes(1) // initial

    // Each heal window fires one retry — but only up to MAX_HEAL_ATTEMPTS (3).
    await vi.advanceTimersByTimeAsync(4000) // heal #1 -> call 2
    await vi.advanceTimersByTimeAsync(4000) // heal #2 -> call 3
    await vi.advanceTimersByTimeAsync(4000) // heal #3 -> call 4 (arms nothing)
    expect(snapshotMock).toHaveBeenCalledTimes(4)

    // Loop is now capped: no further retries no matter how long we wait.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(snapshotMock).toHaveBeenCalledTimes(4)
  })

  it('stops self-healing once issues appear', async () => {
    vi.useFakeTimers()
    // First settle empty -> arms heal; the heal retry returns non-empty.
    snapshotMock
      .mockResolvedValueOnce({ ready: [], all: [], no_db: false })
      .mockResolvedValueOnce({ ready: [{ id: 'A' }], all: [{ id: 'A' }], no_db: false })

    await fetchSnapshot(REPO)
    expect(snapshotMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(4000) // heal fires -> non-empty lands
    expect(snapshotMock).toHaveBeenCalledTimes(2)

    // No further retries: the non-empty result cleared the timer.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(snapshotMock).toHaveBeenCalledTimes(2)
  })

  it('keeps a settled entry after the last subscriber leaves (no stranded siblings)', async () => {
    // Regression for the live bug (2026-08-01): Board loaded but IssueList +
    // Statusline hung on "loading" / counts 0. Cause: unsubscribe deleted the
    // entry at refCount 0, so a re-subscribing sibling saw a fresh EMPTY entry
    // and applySnapshot published to a different entry object. With the fix,
    // the entry persists: cached data survives an unsubscribe and a later
    // subscriber reads it synchronously.
    snapshotMock.mockResolvedValue({ ready: [{ id: 'A' }], all: [{ id: 'A' }, { id: 'B' }], no_db: false })

    const cbA = vi.fn()
    const unsubA = __subscribeForTest(REPO, cbA)
    await fetchSnapshot(REPO)
    expect(__getSnapshotForTest(REPO).loaded).toBe(true)
    expect(__getSnapshotForTest(REPO).all).toHaveLength(2)

    // Last (only) subscriber leaves — pre-fix this deleted the entry.
    unsubA()
    // Data must still be there (entry not destroyed).
    expect(__getSnapshotForTest(REPO).loaded).toBe(true)
    expect(__getSnapshotForTest(REPO).all).toHaveLength(2)

    // A new sibling subscribing later reads the SAME populated snapshot
    // synchronously — no reset to EMPTY, no dependence on a re-notify.
    const cbB = vi.fn()
    __subscribeForTest(REPO, cbB)
    expect(__getSnapshotForTest(REPO).all).toHaveLength(2)
  })

  it('a mid-flight unsubscribe does not strand a sibling still subscribed', async () => {
    let resolve!: (v: { ready: unknown[]; all: unknown[]; no_db: boolean }) => void
    snapshotMock.mockImplementation(
      () => new Promise(r => { resolve = r as typeof resolve }),
    )

    const cbA = vi.fn()
    const cbB = vi.fn()
    const unsubA = __subscribeForTest(REPO, cbA) // Board
    __subscribeForTest(REPO, cbB)                // IssueList (stays)

    const p = fetchSnapshot(REPO)
    unsubA() // Board unmounts mid-flight (StrictMode-style churn)

    resolve({ ready: [{ id: 'A' }], all: [{ id: 'A' }], no_db: false })
    await p

    // The still-subscribed sibling MUST be notified and see the data.
    expect(cbB).toHaveBeenCalled()
    expect(__getSnapshotForTest(REPO).all).toHaveLength(1)
  })

  it('a genuine no-db read sets noDb and does NOT self-heal (stable state)', async () => {
    // RV3.7 (Code-hc9): a repo with no .beads db reports no_db=true. It must
    // set noDb (so the FE labels 'no beads db' rather than mislabeling an empty
    // real repo) AND must not arm the transient-empty self-heal — a missing db
    // is a stable state, not a degrade, so retrying is wasted work.
    vi.useFakeTimers()
    snapshotMock.mockResolvedValue({ ready: [], all: [], no_db: true })

    await fetchSnapshot(REPO)
    expect(snapshotMock).toHaveBeenCalledTimes(1)
    expect(__getSnapshotForTest(REPO).noDb).toBe(true)
    expect(__getSnapshotForTest(REPO).loaded).toBe(true)

    // No self-heal retry for a real no-db repo.
    vi.advanceTimersByTime(10_000)
    expect(snapshotMock).toHaveBeenCalledTimes(1)
  })

  it('an empty real repo (no_db=false) does NOT report noDb', async () => {
    // The other half of the distinction: a genuinely-empty but real repo must
    // report noDb=false so the FE shows "0 issues", not "no beads db".
    snapshotMock.mockResolvedValue({ ready: [], all: [], no_db: false })
    await fetchSnapshot(REPO)
    expect(__getSnapshotForTest(REPO).noDb).toBe(false)
    expect(__getSnapshotForTest(REPO).loaded).toBe(true)
  })
})
