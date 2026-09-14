import { useSyncExternalStore } from 'react'

export type BeadsView = 'terminal-only' | 'explorer' | 'board' | 'both'
export interface UiPreferences {
  view: BeadsView
  sidebarCollapsed: boolean
  /** Terminal focus is deliberately transient and is never restored on boot. */
  terminalFocus: boolean
}

const KEY = 'beads-station.ui-preferences'
const DEFAULTS: UiPreferences = { view: 'explorer', sidebarCollapsed: false, terminalFocus: false }
let state: UiPreferences = load()
const listeners = new Set<() => void>()

function load(): UiPreferences {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<UiPreferences>
    return {
      view: parsed.view === 'terminal-only' || parsed.view === 'explorer' || parsed.view === 'board' || parsed.view === 'both' ? parsed.view : DEFAULTS.view,
      sidebarCollapsed: parsed.sidebarCollapsed === true,
      // Fullscreen terminal focus is a runtime interaction mode. Restoring it
      // can cover the app chrome with a Neovim screen on the next launch.
      terminalFocus: false,
    }
  } catch { return { ...DEFAULTS } }
}
function emit() { try { localStorage.setItem(KEY, JSON.stringify(state)) } catch { /* non-browser */ }; listeners.forEach(l => l()) }
export function useUiPreferences() { return useSyncExternalStore(l => { listeners.add(l); return () => listeners.delete(l) }, () => state, () => state) }
export function setUiPreferences(next: Partial<UiPreferences>) { state = { ...state, ...next }; emit() }
// Selecting a view that includes the Explorer is also an explicit request to
// see it. This matters when a dev/package profile retained the independent
// collapsed flag: without clearing it, Settings can visibly change from Board
// to Explorer while the sidebar remains hidden and offers no recovery path.
export function setBeadsView(view: BeadsView) {
  if (view === 'explorer' || view === 'both') {
    setUiPreferences({ view, sidebarCollapsed: false })
  } else {
    setUiPreferences({ view })
  }
}
export function toggleSidebarPreference() { setUiPreferences({ sidebarCollapsed: !state.sidebarCollapsed }) }
