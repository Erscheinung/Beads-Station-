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

// Code-o40.5 (GAP-1) — cap the transient-empty self-heal. Each heal fetch
// settles and re-runs applySnapshot; a legitimately-empty repo (all=[], not
// no-db) would otherwise re-arm the timer forever, an unbounded background
// refetch loop. Bound it: after MAX_HEAL_ATTEMPTS consecutive empty settles we
// accept the repo as genuinely empty and stop re-arming. A non-empty settle
// resets the counter, so a repo that later fills and empties again can heal
// afresh; a real bd_changed event still refetches directly (it does not go
// through the heal path).
const MAX_HEAL_ATTEMPTS = 3

export interface BdSnapshotState {
  ready: Issue[]
  all: Issue[]
  loaded: boolean
  error: string | null
  /** RV3.7 (Code-hc9) — true only when the backend classified the read as
   * NoDatabase. Consumers gate the "no beads db" label on this, so an empty
   * but real repo (noDb=false, all=[]) is NOT mislabeled as no-db. */
  noDb: boolean
}

interface Entry extends BdSnapshotState {
  // The frozen snapshot object handed to useSyncExternalStore. REPLACED on
  // every change so its identity is a stable between-change ref.
  snap: BdSnapshotState
  inFlight: Promise<void> | null
  subscribers: Set<() => void>
  healTimer: ReturnType<typeof setTimeout> | null
  /** Code-o40.5 — consecutive empty self-heal retries armed so far; reset on
   *  any non-empty settle. Caps the transient-empty refetch loop. */
  healAttempts: number
}

const EMPTY: BdSnapshotState = { ready: [], all: [], loaded: false, error: null, noDb: false }

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
      healAttempts: 0,
    }
    store.set(repoPath, e)
  }
  return e
}

// Rebuild the frozen snapshot ref from the entry's live fields and notify.
function publish(e: Entry): void {
  e.snap = { ready: e.ready, all: e.all, loaded: e.loaded, error: e.error, noDb: e.noDb }
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
      e2.noDb = false
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

// Filter out bd formula/molecule TEMPLATE artifacts. A persisted proto (e.g.
// `bd cook --persist`) leaves an uninstantiated template epic + its step
// children in the graph; bd surfaces the steps in `bd ready`, which polluted
// the board (a stray "Triage {{bead_id}}" READY card) and the sidebar's
// UNLABELED group. Real work never carries a `template` label nor an
// uninstantiated `{{var}}` placeholder in its title.
function notTemplateArtifact(i: Issue): boolean {
  if ((i.labels ?? []).includes('template')) return false
  if (typeof i.title === 'string' && /\{\{[^}]+\}\}/.test(i.title)) return false
  return true
}

// Split out so tests can drive a settled result without a real invoke, and so
// the self-heal scheduling lives in one place.
function applySnapshot(repoPath: string, data: BdSnapshotData): void {
  const e = ensure(repoPath)
  e.ready = data.ready.filter(notTemplateArtifact)
  e.all = data.all.filter(notTemplateArtifact)
  e.error = null
  e.noDb = data.no_db
  e.loaded = true
  clearHeal(e)
  // Transient-empty self-heal: schedule a single retry (see SELF_HEAL_MS). Only
  // for an empty read that is NOT a genuine no-db repo — a real missing-db
  // repo is a stable state, not a transient degrade, so retrying it is wasted
  // work (and would re-arm forever). A truly-empty real repo also self-confirms
  // empty, so retrying it is harmless but pointless; scope the heal to the
  // ambiguous case (empty + not no-db).
  //
  // Code-o40.5: bound the retries. A non-empty settle means the transient
  // resolved — reset the counter. An empty settle re-arms only until the cap,
  // then accepts the repo as genuinely empty and stops (no unbounded loop).
  if (e.all.length > 0) {
    e.healAttempts = 0
  } else if (!e.noDb && e.healAttempts < MAX_HEAL_ATTEMPTS) {
    e.healAttempts += 1
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
    // RV3.6-fix — do NOT delete the entry when the last subscriber leaves.
    // Deleting it raced with the shared in-flight fetch + StrictMode's
    // mount/unmount/remount and per-render resubscribe: a transient refCount==0
    // dropped the entry, so applySnapshot's ensure() rebuilt a DIFFERENT entry
    // and published only to ITS subscribers — stranding sibling consumers
    // (Board loaded, but IssueList + Statusline hung on "loading" / counts 0,
    // observed live 2026-08-01). Entries are bounded by project count and
    // cheap; keep them permanently so all consumers of a repoPath always share
    // ONE stable entry. Only stop the background heal timer when nobody listens.
    if (e2.subscribers.size === 0) {
      clearHeal(e2)
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

// Test-only seams for the subscribe/getSnapshot invariant (entry stability
// across unsubscribe — RV3.6-fix).
export function __subscribeForTest(repoPath: string, cb: () => void): () => void {
  return subscribe(repoPath, cb)
}
export function __getSnapshotForTest(repoPath: string): BdSnapshotState {
  return getSnapshot(repoPath)
}
