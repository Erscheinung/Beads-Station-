import { useSyncExternalStore } from 'react'
import { safeInvoke } from '../lib/invokeErrorBoundary'

// Mirrors the Rust `Project` struct (serde camelCase).
export interface Project {
  id: string
  name: string
  path: string
  hasGit: boolean
  hasBeads: boolean
  claudeSessionId: string
}

const ACTIVE_KEY = 'beads-station.activeProjectId'

function loadPersistedActive(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY)
  } catch {
    return null
  }
}

function persistActive(id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id)
    else localStorage.removeItem(ACTIVE_KEY)
  } catch {
    /* ignore */
  }
}

// Code-bqz — shared project store.
//
// useProjects USED to be a per-component hook: own useState + a fetch-on-mount
// effect. The designer skin mounts ~8 surfaces (DesignerShell, BeadGraph,
// Timeline, ActiveAgents, GateCockpit, SensorsPanel, ConductorControl) that all
// call it, so a single designer render fired ~8 independent `projects_list`
// invokes and kept ~8 divergent copies of the list. That fan-out (compounded on
// every skin flip / project switch) was a measurable slowdown. Hoisted into one
// module-level external store: the list is fetched ONCE (lazy, deduped) and
// fanned out via useSyncExternalStore. Same return shape as before.

interface ProjectsState {
  projects: Project[]
  activeId: string | null
  loaded: boolean
  error: string | null
}

let state: ProjectsState = { projects: [], activeId: null, loaded: false, error: null }
const listeners = new Set<() => void>()
let inFlight: Promise<void> | null = null

function emit(): void {
  listeners.forEach(l => l())
}

function setState(patch: Partial<ProjectsState>): void {
  state = { ...state, ...patch }
  emit()
}

function pickActive(items: Project[], prev: string | null): string | null {
  if (prev && items.some(p => p.id === prev)) return prev
  const persisted = loadPersistedActive()
  if (persisted && items.some(p => p.id === persisted)) return persisted
  return items.length > 0 ? items[0].id : null
}

// Deduped refresh: concurrent callers share ONE in-flight invoke.
export function refreshProjects(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      // safeInvoke with rethrow: fires a global toast on reject AND lets us
      // record an error flag so callers can distinguish a failed load from a
      // genuinely empty project list (both otherwise leave projects=[]).
      const list = await safeInvoke<Project[]>('projects_list', undefined, { rethrow: true })
      const items = list ?? []
      setState({ error: null, projects: items, activeId: pickActive(items, state.activeId), loaded: true })
    } catch (err) {
      console.error('projects_list failed', err)
      setState({ error: String(err), loaded: true })
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

export function setActiveProject(id: string): void {
  persistActive(id)
  setState({ activeId: id })
}

function subscribe(listener: () => void): () => void {
  // First subscriber triggers the one lazy load.
  if (!state.loaded && !inFlight) void refreshProjects()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): ProjectsState {
  // state is replaced (never mutated) so its reference is stable between
  // changes — required for useSyncExternalStore to avoid a re-render loop.
  return state
}

/**
 * Subscribe to the shared project store. All callers see one list, backed by a
 * single deduped `projects_list` fetch. Exposes the same surface the old
 * per-component hook did: { projects, activeId, setActive, refresh, loaded, error }.
 */
export function useProjects() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return {
    projects: snap.projects,
    activeId: snap.activeId,
    setActive: setActiveProject,
    refresh: refreshProjects,
    loaded: snap.loaded,
    error: snap.error,
  }
}
