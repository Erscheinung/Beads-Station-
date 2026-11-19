// Which find surface is open, and where Command+F goes.
//
// Command+F is routed by focus: a conversation view (restored pane, History)
// focuses its own search box; otherwise the terminal find bar opens on the
// active pane. Command+Shift+F opens the same bar in workspace mode.

import { useSyncExternalStore } from 'react'
import { getSkin } from './skin'
import { activePaneId, locatePane, workspaceLeaves } from './termPanes'

export interface FindState { open: boolean; mode: 'pane' | 'workspace'; paneId: string; epoch: number }
let current: FindState = { open: false, mode: 'pane', paneId: '', epoch: 0 }
const listeners = new Set<() => void>()
function set(next: Partial<FindState>) {
  current = { ...current, ...next, epoch: current.epoch + 1 }
  listeners.forEach(listener => listener())
}
export function useFindState(): FindState {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => current, () => current)
}
export function getFindState() { return current }
export function openFind(mode: 'pane' | 'workspace', paneId = activePaneId()) { set({ open: true, mode, paneId }) }
export function closeFind() { if (current.open) set({ open: false }) }

function visibleInputs(root: ParentNode): HTMLInputElement[] {
  return Array.from(root.querySelectorAll<HTMLInputElement>('input[data-find-input]')).filter(input => input.offsetParent !== null)
}

/** The conversation search box Command+F should land in, if one owns the focus. */
export function conversationFindTarget(): HTMLInputElement | null {
  const active = document.activeElement
  const scope = active instanceof Element ? active.closest('[data-restored-pane], [data-find-view]') : null
  if (scope) return visibleInputs(scope)[0] ?? null
  // The Designer is showing: its History view is the only conversation on screen.
  if (getSkin() === 'designer') return visibleInputs(document)[0] ?? null
  // The active pane is a restored agent pane.
  const location = locatePane(activePaneId())
  if (location?.active) {
    const restored = document.querySelector(`[data-restored-pane="${CSS.escape(activePaneId())}"]`)
    if (restored) return visibleInputs(restored)[0] ?? null
  }
  return null
}

export function runFindCommand(mode: 'pane' | 'workspace'): void {
  if (mode === 'pane') {
    const input = conversationFindTarget()
    if (input) { input.focus(); input.select(); return }
  }
  if (getSkin() === 'designer') return
  if (workspaceLeaves().length === 0) return
  if (current.open && current.mode === mode) { set({}); return } // already open: refocus the box
  openFind(mode)
}
