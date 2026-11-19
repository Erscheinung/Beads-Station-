import { useSyncExternalStore } from 'react'
import { type ThemePalette, applyPaletteToCSS, paletteAppearance } from '../lib/themeImport'
import { BUNDLED_THEMES, DEFAULT_THEME_ID, DEFAULT_LIGHT_THEME_ID, DEFAULT_DARK_THEME_ID } from '../themes/index'

import { getSkin, subscribeSkin, type Skin } from './skin'
import { persistDurableUserConfigKey } from '../lib/durableUserConfig'

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'beads-station.theme'
const PALETTE_KEY = 'beads-station.themePaletteId'
const VIEW_KEY = 'beads-station.view-themes.v1'
const MATCH_KEY = 'beads-station.match-system-theme.v1'

/** "Match system appearance": follow prefers-color-scheme with a chosen light and dark theme. */
export interface MatchSystem { enabled: boolean; light: string; dark: string }

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

const legacyId = loadPersisted() === 'light' ? DEFAULT_LIGHT_THEME_ID : loadPersistedPaletteId()
const valid = (id: unknown): id is string => typeof id === 'string' && BUNDLED_THEMES.some(t => t.name === id)
const initialId = valid(legacyId) ? legacyId : DEFAULT_THEME_ID
let viewThemes: Record<Skin, string> = { terminal: initialId, designer: initialId }
try {
  const saved = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}')
  for (const skin of ['terminal', 'designer'] as const) if (valid(saved[skin])) viewThemes[skin] = saved[skin]
} catch { /* optional storage */ }
let matchSystem: MatchSystem = { enabled: false, light: DEFAULT_LIGHT_THEME_ID, dark: DEFAULT_DARK_THEME_ID }
try {
  const saved = JSON.parse(localStorage.getItem(MATCH_KEY) || '{}')
  if (typeof saved.enabled === 'boolean') matchSystem.enabled = saved.enabled
  if (valid(saved.light) && themeAppearance(saved.light) === 'light') matchSystem.light = saved.light
  if (valid(saved.dark) && themeAppearance(saved.dark) === 'dark') matchSystem.dark = saved.dark
} catch { /* optional storage */ }

function themeAppearance(id: string): Theme {
  const p = BUNDLED_THEMES.find(t => t.name === id)
  return p ? paletteAppearance(p) : 'dark'
}

function systemPrefersDark(): boolean {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches } catch { return true }
}

/** The theme the view shows: the system pair while matching, otherwise its own choice. */
function effectiveId(skin: Skin): string {
  return matchSystem.enabled ? (systemPrefersDark() ? matchSystem.dark : matchSystem.light) : viewThemes[skin]
}

let paletteId = effectiveId(getSkin())
let state: Theme = themeAppearance(paletteId)

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
  setThemePalette(t === 'light' ? matchSystem.light : matchSystem.dark)
}

/**
 * How "Toggle theme" moves on: through every bundled theme in list order, or
 * shuffled. Shuffle draws from a bag, so no theme repeats until all were shown.
 */
export type ThemeToggleMode = 'series' | 'shuffle'
const TOGGLE_KEY = 'beads-station.theme-toggle.v1'
let toggleMode: ThemeToggleMode = 'series'
let shuffleBag: string[] = []
try {
  const saved = JSON.parse(localStorage.getItem(TOGGLE_KEY) || '{}')
  if (saved.mode === 'shuffle' || saved.mode === 'series') toggleMode = saved.mode
  if (Array.isArray(saved.bag)) shuffleBag = saved.bag.filter(valid)
} catch { /* optional storage */ }
const toggleListeners = new Set<() => void>()

function saveToggle(): void {
  try { localStorage.setItem(TOGGLE_KEY, JSON.stringify({ mode: toggleMode, bag: shuffleBag })) } catch { /* optional storage */ }
  persistDurableUserConfigKey(TOGGLE_KEY)
  toggleListeners.forEach(fn => fn())
}

export function getThemeToggleMode(): ThemeToggleMode { return toggleMode }
export function setThemeToggleMode(mode: ThemeToggleMode): void {
  toggleMode = mode
  shuffleBag = []
  saveToggle()
}
export function useThemeToggleMode(): ThemeToggleMode {
  return useSyncExternalStore(fn => { toggleListeners.add(fn); return () => { toggleListeners.delete(fn) } }, () => toggleMode, () => toggleMode)
}

/** Pure: the theme after `current`. Exported for tests. */
export function nextThemeId(
  ids: readonly string[], current: string, mode: ThemeToggleMode, bag: string[], random: () => number = Math.random,
): { id: string; bag: string[] } {
  if (ids.length < 2) return { id: current, bag: [] }
  if (mode === 'series') {
    const at = ids.indexOf(current)
    return { id: ids[(at + 1) % ids.length], bag: [] }
  }
  let rest = bag.filter(id => ids.includes(id) && id !== current)
  if (rest.length === 0) rest = ids.filter(id => id !== current)
  const pick = rest[Math.floor(random() * rest.length) % rest.length]
  return { id: pick, bag: rest.filter(id => id !== pick) }
}

export function toggleTheme(): void {
  const ids = BUNDLED_THEMES.map(t => t.name)
  const { id, bag } = nextThemeId(ids, effectiveId(getSkin()), toggleMode, shuffleBag)
  shuffleBag = bag
  saveToggle()
  // A manual pick ends "match system", otherwise the toggle would be undone.
  if (matchSystem.enabled) setMatchSystem({ enabled: false })
  setThemePalette(id)
}

/** A palette command changes only the currently displayed view. */
export function setThemePalette(id: string, skin: Skin = getSkin()): void {
  if (!valid(id)) return
  viewThemes = { ...viewThemes, [skin]: id }
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(viewThemes)) } catch { /* optional storage */ }
  persistDurableUserConfigKey(VIEW_KEY)
  applyCurrentView()
}

export function useViewThemes(): Record<Skin, string> {
  return useSyncExternalStore(subscribeTheme, () => viewThemes, () => viewThemes)
}

function applyCurrentView(): void {
  paletteId = effectiveId(getSkin())
  state = themeAppearance(paletteId)
  try {
    // Keep legacy readers compatible; view-themes is authoritative on reload.
    localStorage.setItem(PALETTE_KEY, paletteId)
    localStorage.setItem(STORAGE_KEY, state)
    persistDurableUserConfigKey(PALETTE_KEY)
    persistDurableUserConfigKey(STORAGE_KEY)
  } catch { /* optional storage */ }
  try { applyPaletteToCSS(BUNDLED_THEMES.find(t => t.name === paletteId)!) } catch { /* non-browser */ }
  emit()
}
const releaseSkin = subscribeSkin(applyCurrentView)
if (import.meta.hot) import.meta.hot.dispose(releaseSkin)

export function getMatchSystem(): MatchSystem {
  return matchSystem
}

export function useMatchSystem(): MatchSystem {
  return useSyncExternalStore(subscribeTheme, getMatchSystem, getMatchSystem)
}

/** Change the system-following settings. A light slot only takes a light theme, a dark slot a dark one. */
export function setMatchSystem(next: Partial<MatchSystem>): void {
  const merged = { ...matchSystem }
  if (typeof next.enabled === 'boolean') merged.enabled = next.enabled
  if (next.light && valid(next.light) && themeAppearance(next.light) === 'light') merged.light = next.light
  if (next.dark && valid(next.dark) && themeAppearance(next.dark) === 'dark') merged.dark = next.dark
  matchSystem = merged
  try { localStorage.setItem(MATCH_KEY, JSON.stringify(matchSystem)) } catch { /* optional storage */ }
  persistDurableUserConfigKey(MATCH_KEY)
  applyCurrentView()
}

// Follow the system live while matching. Re-evaluated on every change event.
try {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const onSystemChange = () => { if (matchSystem.enabled) applyCurrentView() }
  query.addEventListener('change', onSystemChange)
  if (import.meta.hot) import.meta.hot.dispose(() => query.removeEventListener('change', onSystemChange))
} catch { /* no matchMedia (tests) */ }

export { BUNDLED_THEMES }
