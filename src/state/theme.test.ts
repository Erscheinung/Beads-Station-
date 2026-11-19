import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getTheme, setTheme, toggleTheme, setThemePalette, getThemePaletteId, BUNDLED_THEMES } from './theme'

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

  it('toggle moves to the next theme in the list and persists it', () => {
    const before = getThemePaletteId()
    toggleTheme()
    const after = getThemePaletteId()
    expect(after).not.toBe(before)
    const ids = BUNDLED_THEMES.map(t => t.name)
    expect(ids.indexOf(after)).toBe((ids.indexOf(before) + 1) % ids.length)
    expect(localStorage.getItem('beads-station.view-themes.v1')).toContain(after)
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
