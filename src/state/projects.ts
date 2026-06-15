import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

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

  const refresh = useCallback(async () => {
    const list = await invoke<Project[]>('projects_list')
    setProjects(list)
    setActiveIdState(prev => {
      if (prev && list.some(p => p.id === prev)) return prev
      const persisted = loadPersistedActive()
      if (persisted && list.some(p => p.id === persisted)) return persisted
      return list.length > 0 ? list[0].id : null
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
      setLoaded(true)
    })
  }, [refresh])

  return { projects, activeId, setActive, refresh, loaded }
}
