// RV3.3 (Code-1t8) — shared bd snapshot cache.
//
// Before this, one `bd_changed` event (or a repo mount) fanned out into
// INDEPENDENT bd reads from three components — Board (bdReady+bdList),
// IssueList (bdList), and Statusline (bd_counts = bd_ready+bd_list) — each
// spawning the 130MB `bd` Go binary through the lockf concurrency semaphore.
// Measured 3.7->8.0s escalating cold; boards felt dead.
//
// This module keeps ONE deduped `bd_snapshot` fetch per repoPath and fans the
// result out to every subscriber. A `bd_changed` burst collapses to a single
// backend round-trip. Consumers subscribe via `useBdSnapshot`, which wires the
// shared `useBdLiveContext` change signal to `invalidate` — so the entire
// board + sidebar + statusline refresh from one fetch.
//
// Pattern mirrors BdLiveProvider.tsx (ref-counted per-repoPath entry, no React
// state in the store) and the useSyncExternalStore cached-snapshot discipline
// in state/termPanes.ts + state/vim.ts (the store object is REPLACED, never
// mutated in place, so getEntry returns a stable ref between changes — this is
// what keeps React 19 from looping on getSnapshot, the R3.5 lesson).

import { useEffect } from 'react'
import { useSyncExternalStore } from 'react'
import { bdSnapshot, type BdSnapshotData, type Issue } from '../types/issue'
import { useBdLiveContext } from './BdLiveProvider'

// Self-heal: bd reads can momentarily degrade to an empty result under
// subprocess/fork pressure (the backend maps a NoDatabase classification to
// []). Without recovery a transient empty LATCHES as "no beads db" forever
// (RV3.2 / Code-hc9). While a settled snapshot is loaded-empty-no-error, we
// schedule ONE retry after this delay — NOT a steady poll; it stops the instant
// issues appear or a real error surfaces.
const SELF_HEAL_MS = 4000

export interface BdSnapshotState {
  ready: Issue[]
  all: Issue[]
  loaded: boolean
  error: string | null
}

interface Entry extends BdSnapshotState {
  // The frozen snapshot object handed to useSyncExternalStore. REPLACED on
  // every change so its identity is a stable between-change ref.
  snap: BdSnapshotState
  inFlight: Promise<void> | null
  subscribers: Set<() => void>
  healTimer: ReturnType<typeof setTimeout> | null
}

const EMPTY: BdSnapshotState = { ready: [], all: [], loaded: false, error: null }

const store = new Map<string, Entry>()

function ensure(repoPath: string): Entry {
  let e = store.get(repoPath)
  if (!e) {
    e = {
      ...EMPTY,
      snap: EMPTY,
      inFlight: null,
      subscribers: new Set(),
      healTimer: null,
    }
    store.set(repoPath, e)
  }
  return e
}

// Rebuild the frozen snapshot ref from the entry's live fields and notify.
function publish(e: Entry): void {
  e.snap = { ready: e.ready, all: e.all, loaded: e.loaded, error: e.error }
  e.subscribers.forEach(cb => cb())
}

function clearHeal(e: Entry): void {
  if (e.healTimer !== null) {
    clearTimeout(e.healTimer)
    e.healTimer = null
  }
}

/**
 * Fetch a fresh snapshot for `repoPath`, deduping concurrent callers: if a
 * fetch is already in flight, the existing promise is returned so three
 * simultaneous consumers (or a mount + a bd_changed) share ONE
 * `invoke('bd_snapshot')`. On settle, the cache is updated and all subscribers
 * are notified.
 */
export function fetchSnapshot(repoPath: string): Promise<void> {
  const e = ensure(repoPath)
  if (e.inFlight) return e.inFlight

  const p = bdSnapshot(repoPath)
    .then(data => {
      applySnapshot(repoPath, data)
    })
    .catch((err: unknown) => {
      const e2 = ensure(repoPath)
      e2.error = String(err)
      e2.loaded = true
      clearHeal(e2)
      publish(e2)
    })
    .finally(() => {
      const e2 = store.get(repoPath)
      if (e2) e2.inFlight = null
    })

  e.inFlight = p
  return p
}

// Split out so tests can drive a settled result without a real invoke, and so
// the self-heal scheduling lives in one place.
function applySnapshot(repoPath: string, data: BdSnapshotData): void {
  const e = ensure(repoPath)
  e.ready = data.ready
  e.all = data.all
  e.error = null
  e.loaded = true
  clearHeal(e)
  // Transient-empty self-heal: schedule a single retry (see SELF_HEAL_MS).
  if (e.all.length === 0) {
    e.healTimer = setTimeout(() => {
      e.healTimer = null
      void fetchSnapshot(repoPath)
    }, SELF_HEAL_MS)
  }
  publish(e)
}

/** Trigger a refetch (used by the bd_changed fan-out). Alias of fetchSnapshot. */
export function invalidate(repoPath: string): void {
  void fetchSnapshot(repoPath)
}

function subscribe(repoPath: string, cb: () => void): () => void {
  const e = ensure(repoPath)
  e.subscribers.add(cb)
  return () => {
    const e2 = store.get(repoPath)
    if (!e2) return
    e2.subscribers.delete(cb)
    if (e2.subscribers.size === 0) {
      clearHeal(e2)
      store.delete(repoPath)
    }
  }
}

function getSnapshot(repoPath: string): BdSnapshotState {
  return store.get(repoPath)?.snap ?? EMPTY
}

/**
 * Subscribe a component to the shared bd snapshot for `repoPath`. Fires an
 * initial fetch on mount / repoPath change and refetches (deduped) on every
 * bd_changed event via the shared BdLiveProvider listener. All consumers of the
 * same repoPath share ONE fetch and ONE listener.
 */
export function useBdSnapshot(repoPath: string): BdSnapshotState {
  const state = useSyncExternalStore(
    cb => subscribe(repoPath, cb),
    () => getSnapshot(repoPath),
    () => getSnapshot(repoPath),
  )

  useEffect(() => {
    if (!repoPath) return
    void fetchSnapshot(repoPath)
  }, [repoPath])

  // One shared bd_changed listener -> one deduped refetch -> fan-out.
  useBdLiveContext(repoPath, () => invalidate(repoPath))

  return state
}

// Test-only seam: reset the module store between cases.
export function __resetBdCacheForTest(): void {
  store.forEach(clearHeal)
  store.clear()
}

// Test-only seam: drive a settled snapshot without a real invoke.
export function __applySnapshotForTest(repoPath: string, data: BdSnapshotData): void {
  applySnapshot(repoPath, data)
}
