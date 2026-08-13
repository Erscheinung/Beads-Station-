import { describe, it, expect, beforeEach } from 'vitest'
import { getTheme, setTheme, toggleTheme } from './theme'

// Phase 9 (Code-ky4.9) — theme store toggle + localStorage persistence.

describe('theme store', () => {
  beforeEach(() => {
    localStorage.clear()
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
