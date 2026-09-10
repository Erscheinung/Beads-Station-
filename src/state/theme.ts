// Phase 9 (Code-ky4.9) — runtime theme toggle.
//
// The app ships two token layers: the default dark (Tokyonight Storm) on
// `:root` (src/index.css) and a light layer scoped to the `.du-theme` class
// (src/theme/designer-light.css). Before Phase 9 the light layer was reachable
// only via the designer skin. This store exposes a real light/dark toggle: it
// flips `.du-theme` on the primary shell root and persists the choice.
//
// Code-6wx — palette-driven surfaces. A ThemePalette can be set to recolor the
// terminal + all --bs-* CSS tokens from one source. Bundled themes live in
// src/themes/index.ts; the active palette id is persisted in localStorage.
//
// Same tiny external-store shape as vim.ts (useSyncExternalStore + a window
// mirror for tests) — no zustand/jotai.

import { useSyncExternalStore } from 'react'
import { type ThemePalette, applyPaletteToCSS } from '../lib/themeImport'
import { BUNDLED_THEMES, DEFAULT_THEME_ID } from '../themes/index'

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'beads-station.theme'
const PALETTE_KEY = 'beads-station.themePaletteId'

function loadPersisted(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

function loadPersistedPaletteId(): string {
  try {
    return localStorage.getItem(PALETTE_KEY) ?? DEFAULT_THEME_ID
  } catch {
    return DEFAULT_THEME_ID
  }
}

let state: Theme = loadPersisted()
let paletteId: string = loadPersistedPaletteId()
if (!BUNDLED_THEMES.some(t => t.name === paletteId)) paletteId = DEFAULT_THEME_ID
if (state === 'light') paletteId = 'one-light'
state = paletteId === 'one-light' ? 'light' : 'dark'

const listeners = new Set<() => void>()

function emit(): void {
  try {
    ;(window as unknown as { __bsTheme?: Theme; __bsThemePaletteId?: string }).__bsTheme = state
    ;(window as unknown as { __bsTheme?: Theme; __bsThemePaletteId?: string }).__bsThemePaletteId = paletteId
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

function getPaletteIdSnapshot(): string {
  return paletteId
}

try {
  ;(window as unknown as { __bsTheme?: Theme; __bsThemePaletteId?: string }).__bsTheme = state
  ;(window as unknown as { __bsTheme?: Theme; __bsThemePaletteId?: string }).__bsThemePaletteId = paletteId
} catch {
  /* noop */
}

// Apply persisted palette on load (non-default only — default matches stylesheet).
{
  const p = BUNDLED_THEMES.find(t => t.name === paletteId)
  if (p) {
    try { applyPaletteToCSS(p) } catch { /* non-browser */ }
  }
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useThemePaletteId(): string {
  return useSyncExternalStore(subscribe, getPaletteIdSnapshot, getPaletteIdSnapshot)
}

export function getTheme(): Theme {
  return state
}

export function getThemePaletteId(): string {
  return paletteId
}

export function getActivePalette(): ThemePalette | undefined {
  return BUNDLED_THEMES.find(t => t.name === paletteId)
}

export function setTheme(t: Theme): void {
  setThemePalette(t === 'light' ? 'one-light' : DEFAULT_THEME_ID)
}

export function toggleTheme(): void {
  setTheme(state === 'dark' ? 'light' : 'dark')
}

export function setThemePalette(id: string): void {
  const palette = BUNDLED_THEMES.find(t => t.name === id)
  if (!palette) return
  paletteId = id
  state = id === 'one-light' ? 'light' : 'dark'
  try {
    localStorage.setItem(PALETTE_KEY, id)
    localStorage.setItem(STORAGE_KEY, state)
  } catch {
    /* noop */
  }
  try { applyPaletteToCSS(palette) } catch { /* noop */ }
  emit()
}

export { BUNDLED_THEMES }
