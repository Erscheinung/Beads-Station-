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

import { fetchSnapshot, __resetBdCacheForTest } from './bdCache'

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
    let resolve!: (v: { ready: unknown[]; all: unknown[] }) => void
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

    resolve({ ready: [{ id: 'A' }], all: [{ id: 'A' }] })
    await Promise.all([p1, p2, p3])

    // A fresh fetch after settle issues a new call (inFlight cleared).
    snapshotMock.mockResolvedValueOnce({ ready: [], all: [{ id: 'A' }] })
    await fetchSnapshot(REPO)
    expect(snapshotMock).toHaveBeenCalledTimes(2)
  })

  it('schedules exactly one self-heal retry on a settled empty snapshot', async () => {
    vi.useFakeTimers()
    snapshotMock.mockResolvedValue({ ready: [], all: [] })

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
    snapshotMock.mockResolvedValue({ ready: [{ id: 'A' }], all: [{ id: 'A' }] })

    await fetchSnapshot(REPO)
    expect(snapshotMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(10_000)
    expect(snapshotMock).toHaveBeenCalledTimes(1) // no self-heal for non-empty
  })

  it('stops self-healing once issues appear', async () => {
    vi.useFakeTimers()
    // First settle empty -> arms heal; the heal retry returns non-empty.
    snapshotMock
      .mockResolvedValueOnce({ ready: [], all: [] })
      .mockResolvedValueOnce({ ready: [{ id: 'A' }], all: [{ id: 'A' }] })

    await fetchSnapshot(REPO)
    expect(snapshotMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(4000) // heal fires -> non-empty lands
    expect(snapshotMock).toHaveBeenCalledTimes(2)

    // No further retries: the non-empty result cleared the timer.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(snapshotMock).toHaveBeenCalledTimes(2)
  })
})
