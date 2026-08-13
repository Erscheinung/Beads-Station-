// Phase 9 (Code-ky4.9) — runtime theme toggle.
//
// The app ships two token layers: the default dark (Tokyonight Storm) on
// `:root` (src/index.css) and a light layer scoped to the `.du-theme` class
// (src/theme/designer-light.css). Before Phase 9 the light layer was reachable
// only via the designer skin. This store exposes a real light/dark toggle: it
// flips `.du-theme` on the primary shell root and persists the choice.
//
// Same tiny external-store shape as vim.ts (useSyncExternalStore + a window
// mirror for tests) — no zustand/jotai.

import { useSyncExternalStore } from 'react'

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'beads-station.theme'

function loadPersisted(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

let state: Theme = loadPersisted()
const listeners = new Set<() => void>()

function emit(): void {
  try {
    ;(window as unknown as { __bsTheme?: Theme }).__bsTheme = state
  } catch {
    /* non-browser */
  }
  listeners.forEach(l => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): Theme {
  return state
}

try {
  ;(window as unknown as { __bsTheme?: Theme }).__bsTheme = state
} catch {
  /* noop */
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function getTheme(): Theme {
  return state
}

export function setTheme(t: Theme): void {
  if (state === t) return
  state = t
  try {
    localStorage.setItem(STORAGE_KEY, t)
  } catch {
    /* noop */
  }
  emit()
}

export function toggleTheme(): void {
  setTheme(state === 'dark' ? 'light' : 'dark')
}
