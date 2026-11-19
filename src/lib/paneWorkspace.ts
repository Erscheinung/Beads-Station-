import { locatePane } from '../state/termPanes'
import { getProject, getActiveProjectId } from '../state/projects'

export interface PaneWorkspace { id: string; name: string; path: string }

/** The workspace a pane belongs to: a terminal pane's own, or the Designer session pane `designer:<id>`. Null when unknown. */
export function paneWorkspace(paneId: string): PaneWorkspace | null {
  try {
    const id = paneId.startsWith('designer:') ? paneId.slice('designer:'.length) : locatePane(paneId)?.projectId ?? null
    const project = id ? getProject(id) : null
    return project ? { id: project.id, name: project.name, path: project.path } : null
  } catch {
    return null
  }
}

export function activeWorkspace(): PaneWorkspace | null {
  const id = getActiveProjectId()
  const project = id ? getProject(id) : null
  return project ? { id: project.id, name: project.name, path: project.path } : null
}
