// Phase 9 (Code-ky4.9) — command palette open/close state.
//
// A tiny external store (same shape as vim.ts) so both the CommandPalette
// component and useVimNav (which suppresses nav keys while the palette is open)
// can read it, plus a `window.__bsPalette` mirror for imperative reads +
// Playwright. Opening the palette also flips the vim store into 'command' mode
// (that mode existed unused since Phase 4) so the Statusline reflects it and the
// keymap knows to stand down.

import { useSyncExternalStore } from 'react'
import { setMode } from './vim'

export interface PaletteState {
  open: boolean
}

let state: PaletteState = { open: false }
const listeners = new Set<() => void>()

function emit(): void {
  try {
    ;(window as unknown as { __bsPalette?: PaletteState }).__bsPalette = state
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

function getSnapshot(): PaletteState {
  return state
}

try {
  ;(window as unknown as { __bsPalette?: PaletteState }).__bsPalette = state
} catch {
  /* noop */
}

export function usePalette(): PaletteState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function openPalette(): void {
  if (state.open) return
  state = { open: true }
  setMode('command')
  emit()
}

export function closePalette(): void {
  if (!state.open) return
  state = { open: false }
  setMode('normal')
  emit()
}
