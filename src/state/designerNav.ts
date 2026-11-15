// Which Designer view is showing. Kept outside React so the top bar, the
// command palette and keyboard shortcuts can all go straight to a view from
// anywhere, including the Terminal skin.

import { useSyncExternalStore } from 'react'
import { setSkin } from './skin'

export type DesignerView = 'requests' | 'session' | 'history' | 'shelf' | 'graph' | 'agents' | 'timeline'

export interface DesignerViewInfo {
  id: DesignerView
  label: string
  /** One plain sentence: what this view is for. Shown at the top of the view and in the palette. */
  purpose: string
}

export const DESIGNER_VIEWS: readonly DesignerViewInfo[] = [
  { id: 'requests', label: 'Requests', purpose: 'Your tickets as a board. Open one to run an agent on it and review what it made.' },
  { id: 'session', label: 'Session', purpose: 'Talk to Claude or Codex on the left; the files it changes appear on the right.' },
  { id: 'history', label: 'History', purpose: 'Read any past or running conversation in this folder, and continue one.' },
  { id: 'shelf', label: 'Pinned', purpose: 'Text, files and notes you pinned. Type them into an agent prompt when you need them.' },
  { id: 'graph', label: 'Bead map', purpose: 'How tickets depend on each other: lanes are parents, arrows are blockers.' },
  { id: 'agents', label: 'Agents', purpose: 'Claude, Codex and Qwen sessions running now with their subagents, and local conductor runs.' },
  { id: 'timeline', label: 'Timeline', purpose: 'Closed tickets and agent sessions, newest first.' },
]

export function designerViewInfo(id: DesignerView): DesignerViewInfo {
  return DESIGNER_VIEWS.find(view => view.id === id) ?? DESIGNER_VIEWS[0]
}

const STORAGE_KEY = 'beads-station.designer-view'

function load(): DesignerView {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (DESIGNER_VIEWS.some(view => view.id === saved)) return saved as DesignerView
  } catch { /* optional storage */ }
  return 'requests'
}

let current: DesignerView = load()
const listeners = new Set<() => void>()

export function getDesignerView(): DesignerView {
  return current
}

export function setDesignerView(view: DesignerView): void {
  if (view === current || !DESIGNER_VIEWS.some(candidate => candidate.id === view)) return
  current = view
  // A per-device convenience, not durable config.
  try { localStorage.setItem(STORAGE_KEY, view) } catch { /* optional storage */ }
  listeners.forEach(listener => listener())
}

/** Go straight to a Designer view from anywhere. Shows a view; starts nothing. */
export function openDesignerView(view: DesignerView): void {
  setDesignerView(view)
  setSkin('designer')
}

export function useDesignerView(): DesignerView {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getDesignerView,
    getDesignerView,
  )
}
