import { useCallback, useEffect, useState } from 'react'
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

/**
 * Tiny Zustand-free project hook. On first mount, asks the Tauri backend
 * for the project list, picks an active id (persisted across reloads), and
 * exposes a refresh + setActive API.
 */
export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([])
  const [activeId, setActiveIdState] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    // safeInvoke with rethrow: fires a global toast on reject AND lets the
    // effect's catch record an error flag so App can distinguish a failed
    // load from a genuinely empty project list (which look identical
    // otherwise — both leave projects=[]).
    const list = await safeInvoke<Project[]>('projects_list', undefined, { rethrow: true })
    setError(null)
    setProjects(list ?? [])
    setActiveIdState(prev => {
      const items = list ?? []
      if (prev && items.some(p => p.id === prev)) return prev
      const persisted = loadPersistedActive()
      if (persisted && items.some(p => p.id === persisted)) return persisted
      return items.length > 0 ? items[0].id : null
    })
    setLoaded(true)
  }, [])

  const setActive = useCallback((id: string) => {
    setActiveIdState(id)
    persistActive(id)
  }, [])

  useEffect(() => {
    refresh().catch(err => {
      console.error('projects_list failed', err)
      setError(String(err))
      setLoaded(true)
    })
  }, [refresh])

  return { projects, activeId, setActive, refresh, loaded, error }
}
