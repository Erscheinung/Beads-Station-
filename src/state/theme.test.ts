import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getTheme, setTheme, toggleTheme, setThemePalette, getThemePaletteId } from './theme'

import { setSkin } from './skin'

// Phase 9 (Code-ky4.9) — theme store toggle + localStorage persistence.

describe('theme store', () => {
  beforeEach(() => {
    localStorage.clear()
    setSkin('terminal')
    setTheme('dark')
  })

  it('defaults to dark', () => {
    expect(getTheme()).toBe('dark')
  })

  it('toggles dark <-> light and persists to localStorage', () => {
    toggleTheme()
    expect(getTheme()).toBe('light')
    expect(localStorage.getItem('beads-station.theme')).toBe('light')
    toggleTheme()
    expect(getTheme()).toBe('dark')
    expect(localStorage.getItem('beads-station.theme')).toBe('dark')
  })

  it('mirrors onto window.__bsTheme', () => {
    setTheme('light')
    expect((window as unknown as { __bsTheme?: string }).__bsTheme).toBe('light')
  })
})

it('keeps independent themes and applies only the visible view', () => {
  setSkin('terminal')
  setThemePalette('fahrenheit')
  setThemePalette('one-light', 'designer')
  expect(getThemePaletteId()).toBe('fahrenheit')
  setSkin('designer')
  expect(getTheme()).toBe('light')
  expect(getThemePaletteId()).toBe('one-light')
  setSkin('terminal')
  expect(getThemePaletteId()).toBe('fahrenheit')
  expect(JSON.parse(localStorage.getItem('beads-station.view-themes.v1')!)).toEqual({ terminal: 'fahrenheit', designer: 'one-light' })
})

it('migrates the old global palette and restores scoped choices ahead of legacy keys', async () => {
  localStorage.clear()
  localStorage.setItem('beads-station.themePaletteId', 'gruvbox-dark')
  vi.resetModules()
  const first = await import('./theme')
  const firstSkin = await import('./skin')
  expect(first.getThemePaletteId()).toBe('gruvbox-dark')
  firstSkin.setSkin('designer')
  expect(first.getThemePaletteId()).toBe('gruvbox-dark')
  first.setThemePalette('one-light')
  first.setThemePalette('fahrenheit', 'terminal')
  localStorage.setItem('beads-station.themePaletteId', 'rose-pine')
  vi.resetModules()
  const restored = await import('./theme')
  const restoredSkin = await import('./skin')
  expect(restored.getThemePaletteId()).toBe('one-light')
  restoredSkin.setSkin('terminal')
  expect(restored.getThemePaletteId()).toBe('fahrenheit')
})
