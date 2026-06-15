// Phase 4 — Vim modal navigation state.
//
// A tiny external store that React components can subscribe to via
// useSyncExternalStore. We deliberately avoid pulling in zustand/jotai
// here; the surface area is four fields and three setters.
//
// The current state is also mirrored on `window.__bsVim` so that
// non-reactive consumers (e.g. the Statusline that polls on a tick,
// or imperative code in event handlers) can read it without
// subscribing.

import { useSyncExternalStore } from 'react'

export type VimMode = 'normal' | 'insert' | 'command'
export type VimFocus = 'sidebar' | 'board' | 'chat' | 'terminal'

export interface VimState {
  mode: VimMode
  leaderActive: boolean
  focused: VimFocus
}

let state: VimState = {
  mode: 'normal',
  leaderActive: false,
  focused: 'board',
}

const listeners = new Set<() => void>()

function emit(): void {
  // Mirror onto window for non-reactive readers (statusline, etc.).
  try {
    ;(window as unknown as { __bsVim?: VimState }).__bsVim = state
  } catch {
    // SSR / non-browser context — ignore.
  }
  listeners.forEach(l => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): VimState {
  return state
}

// Initialise window mirror once at module load so the statusline can
// read it before any component subscribes.
try {
  ;(window as unknown as { __bsVim?: VimState }).__bsVim = state
} catch {
  /* noop */
}

export function useVim(): VimState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function setMode(m: VimMode): void {
  if (state.mode === m) return
  state = { ...state, mode: m }
  emit()
}

export function setFocused(f: VimFocus): void {
  if (state.focused === f) return
  state = { ...state, focused: f }
  emit()
}

export function setLeaderActive(b: boolean): void {
  if (state.leaderActive === b) return
  state = { ...state, leaderActive: b }
  emit()
}
