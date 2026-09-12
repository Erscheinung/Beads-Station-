import { useSyncExternalStore } from 'react'
import { type ThemePalette, applyPaletteToCSS } from '../lib/themeImport'
import { BUNDLED_THEMES, DEFAULT_THEME_ID } from '../themes/index'

import { getSkin, subscribeSkin, type Skin } from './skin'

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'beads-station.theme'
const PALETTE_KEY = 'beads-station.themePaletteId'
const VIEW_KEY = 'beads-station.view-themes.v1'

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

const legacyId = loadPersisted() === 'light' ? 'one-light' : loadPersistedPaletteId()
const valid = (id: unknown): id is string => typeof id === 'string' && BUNDLED_THEMES.some(t => t.name === id)
const initialId = valid(legacyId) ? legacyId : DEFAULT_THEME_ID
let viewThemes: Record<Skin, string> = { terminal: initialId, designer: initialId }
try {
  const saved = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}')
  for (const skin of ['terminal', 'designer'] as const) if (valid(saved[skin])) viewThemes[skin] = saved[skin]
} catch { /* optional storage */ }
let paletteId = viewThemes[getSkin()]
let state: Theme = paletteId === 'one-light' ? 'light' : 'dark'

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

export function subscribeTheme(listener: () => void): () => void {
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
  return useSyncExternalStore(subscribeTheme, getSnapshot, getSnapshot)
}

export function useThemePaletteId(): string {
  return useSyncExternalStore(subscribeTheme, getPaletteIdSnapshot, getPaletteIdSnapshot)
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

/** A palette command changes only the currently displayed view. */
export function setThemePalette(id: string, skin: Skin = getSkin()): void {
  if (!valid(id)) return
  viewThemes = { ...viewThemes, [skin]: id }
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(viewThemes)) } catch { /* optional storage */ }
  applyCurrentView()
}

export function useViewThemes(): Record<Skin, string> {
  return useSyncExternalStore(subscribeTheme, () => viewThemes, () => viewThemes)
}

function applyCurrentView(): void {
  paletteId = viewThemes[getSkin()]
  state = paletteId === 'one-light' ? 'light' : 'dark'
  try {
    // Keep legacy readers compatible; view-themes is authoritative on reload.
    localStorage.setItem(PALETTE_KEY, paletteId)
    localStorage.setItem(STORAGE_KEY, state)
  } catch { /* optional storage */ }
  try { applyPaletteToCSS(BUNDLED_THEMES.find(t => t.name === paletteId)!) } catch { /* non-browser */ }
  emit()
}
const releaseSkin = subscribeSkin(applyCurrentView)
if (import.meta.hot) import.meta.hot.dispose(releaseSkin)

export { BUNDLED_THEMES }
