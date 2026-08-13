import { describe, it, expect, beforeEach } from 'vitest'
import { openPalette, closePalette, usePalette } from './palette'
import { useVim } from './vim'
import { renderHook, act } from '@testing-library/react'

// Phase 9 (Code-ky4.9) — palette store open/close + its vim-mode side effect.

describe('palette store', () => {
  beforeEach(() => {
    closePalette()
  })

  it('opens and closes, mirroring onto window.__bsPalette', () => {
    const { result } = renderHook(() => usePalette())
    expect(result.current.open).toBe(false)

    act(() => openPalette())
    expect(result.current.open).toBe(true)
    expect((window as unknown as { __bsPalette?: { open: boolean } }).__bsPalette?.open).toBe(true)

    act(() => closePalette())
    expect(result.current.open).toBe(false)
    expect((window as unknown as { __bsPalette?: { open: boolean } }).__bsPalette?.open).toBe(false)
  })

  it('flips vim mode to command on open and back to normal on close', () => {
    const { result } = renderHook(() => useVim())
    act(() => openPalette())
    expect(result.current.mode).toBe('command')
    act(() => closePalette())
    expect(result.current.mode).toBe('normal')
  })

  it('open/close are idempotent', () => {
    const { result } = renderHook(() => usePalette())
    act(() => {
      openPalette()
      openPalette()
    })
    expect(result.current.open).toBe(true)
    act(() => {
      closePalette()
      closePalette()
    })
    expect(result.current.open).toBe(false)
  })
})
