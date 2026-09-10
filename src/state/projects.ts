import { useMemo, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { safeInvoke } from '../lib/invokeErrorBoundary'
import { migrateProjectSurface, removeProjectSurface, setActiveProject as activateSurface } from './termPanes'

export interface Project {
  id: string
  name: string
  path: string
  hasGit: boolean
  hasBeads: boolean
  claudeSessionId: string
}
export interface Discovery {
  projects: Project[]
  roots: string[]
  warnings: string[]
}
const WORKSPACES_KEY = 'beads-station.workspaces.v2'
const LEGACY_ACTIVE_KEY = 'beads-station.activeProjectId'
interface WorkspaceSelection { openIds: string[]; activeId: string | null }

export function restoreSelection(projects: Project[], saved: string | null, legacy: string | null): WorkspaceSelection {
  const resolve = (id: unknown): string | undefined => {
    if (typeof id !== 'string') return
    if (projects.some(p => p.id === id)) return id
    const pathMatch = projects.find(p => p.path === id)
    if (pathMatch) return pathMatch.id
    const matches = projects.filter(p => p.name === id)
    return matches.length === 1 ? matches[0].id : undefined
  }
  try {
    if (saved !== null) {
      const value = JSON.parse(saved)
      if (!Array.isArray(value.openIds)) return { openIds: [], activeId: null }
      const openIds = [...new Set<string>(value.openIds.map(resolve).filter((id: unknown): id is string => typeof id === 'string'))]
      const active = resolve(value.activeId)
      return { openIds, activeId: active && openIds.includes(active) ? active : openIds[0] ?? null }
    }
  } catch { return { openIds: [], activeId: null } }
  // Old versions opened every discovered folder. Only preserve their active one.
  const activeId = resolve(legacy) ?? null
  return { openIds: activeId ? [activeId] : [], activeId }
}

interface ProjectsState extends WorkspaceSelection {
  availableProjects: Project[]
  roots: string[]
  warnings: string[]
  loaded: boolean
  error: string | null
}
let state: ProjectsState = { availableProjects: [], openIds: [], activeId: null, roots: [], warnings: [], loaded: false, error: null }
const listeners = new Set<() => void>()
let inFlight: Promise<void> | null = null

function setState(patch: Partial<ProjectsState>) {
  state = { ...state, ...patch }
  listeners.forEach(l => l())
}
function persistSelection() {
  try {
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify({ openIds: state.openIds, activeId: state.activeId }))
    localStorage.removeItem(LEGACY_ACTIVE_KEY)
  } catch { /* private browsing / quota: the current session still works */ }
}
function applyDiscovery(result: Discovery) {
  let selection: WorkspaceSelection = { openIds: state.openIds, activeId: state.activeId }
  if (!state.loaded) {
    try { selection = restoreSelection(result.projects, localStorage.getItem(WORKSPACES_KEY), localStorage.getItem(LEGACY_ACTIVE_KEY)) }
    catch { selection = { openIds: [], activeId: null } }
    for (const project of result.projects) {
      migrateProjectSurface(project.path, project.id)
      if (project.name !== project.id && result.projects.filter(p => p.name === project.name).length === 1) {
        migrateProjectSurface(project.name, project.id)
        for (const prefix of ['beads-station.terminalHeight.', 'beads-station.lastConfirmed.', 'bs.claude.session:']) {
          try {
            const old = localStorage.getItem(prefix + project.name)
            if (old !== null && localStorage.getItem(prefix + project.id) === null) localStorage.setItem(prefix + project.id, old)
          } catch { /* optional migration */ }
        }
      }
    }
  }
  // A missing scan root must not evict already-open workspaces in this session.
  const retained = state.availableProjects.filter(p => state.openIds.includes(p.id) && !result.projects.some(n => n.id === p.id))
  const active = result.projects.find(p => p.id === selection.activeId)
  if (active) activateSurface(active.id, active.path)
  setState({ ...selection, availableProjects: [...result.projects, ...retained], roots: result.roots, warnings: result.warnings, loaded: true, error: null })
  persistSelection()
}

export function refreshProjects(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const result = await safeInvoke<Discovery>('projects_list', undefined, { rethrow: true })
      if (!result) throw new Error('Project discovery returned no result')
      applyDiscovery(result)
    } catch (error) {
      setState({ error: String(error), loaded: true })
    } finally { inFlight = null }
  })()
  return inFlight
}

export async function openFolder(path: string): Promise<void> {
  const project = await invoke<Project>('projects_open', { path })
  const availableProjects = [...state.availableProjects.filter(p => p.id !== project.id), project]
  activateSurface(project.id, project.path)
  setState({ availableProjects, openIds: state.openIds.includes(project.id) ? state.openIds : [...state.openIds, project.id], activeId: project.id })
  persistSelection()
}

export function setActiveProject(id: string): void {
  // Opening a discovered project is explicit; selecting an open one is synchronous.
  if (state.openIds.includes(id)) {
    const project = state.availableProjects.find(p => p.id === id)
    if (project) activateSurface(project.id, project.path)
    setState({ activeId: id })
    persistSelection()
  } else {
    const project = state.availableProjects.find(p => p.id === id)
    if (project) void openFolder(project.path).catch(error => setState({ error: String(error) }))
  }
}

export async function closeProject(id: string): Promise<void> {
  // Closing is distinct from switching. Stop only this workspace's resources.
  const resources = removeProjectSurface(id)
  const openIds = state.openIds.filter(p => p !== id)
  const activeId = state.activeId === id ? openIds[0] ?? null : state.activeId
  const active = state.availableProjects.find(p => p.id === activeId)
  if (active) activateSurface(active.id, active.path)
  setState({ openIds, activeId })
  persistSelection()
  await Promise.allSettled([
    ...resources.ptyIds.map(ptyId => invoke('pty_kill', { id: ptyId })),
    ...resources.bridgeIds.map(projectId => invoke('claude_kill', { projectId })),
    invoke('claude_kill', { projectId: id }),
  ])
}

export async function saveRoots(roots: string[]): Promise<void> {
  applyDiscovery(await invoke<Discovery>('projects_set_roots', { roots }))
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!state.loaded && !inFlight) void refreshProjects()
  return () => { listeners.delete(listener) }
}
function getSnapshot() { return state }
export function useProjects() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const projects = useMemo(() => snap.openIds.flatMap(id => { const project = snap.availableProjects.find(p => p.id === id); return project ? [project] : [] }), [snap.openIds, snap.availableProjects])
  return {
    ...snap,
    projects,
    setActive: setActiveProject, refresh: refreshProjects, openFolder, closeProject, saveRoots,
  }
}
