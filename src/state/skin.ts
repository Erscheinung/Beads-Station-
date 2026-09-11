// Code-6if — runtime skin toggle (terminal <-> designer).
//
// Before this, the skin was chosen ONLY by the ?ui=designer URL param
// (tauri.conf.json devUrl). WKWebView has no address bar, so in a running
// window one skin was unreachable from the other. This store hoists the skin
// into runtime state so an in-app control (designer top-bar button + terminal
// command-palette entry) can flip it live, and persists the choice.
//
// Initial value: the persisted choice wins; on a fresh install we honour the
// ?ui=designer param so the existing dev entry point still lands on designer.
//
// Same external-store shape as state/theme.ts (useSyncExternalStore + a window
// mirror for tests).

import { useSyncExternalStore } from 'react'

export type Skin = 'terminal' | 'designer'

const STORAGE_KEY = 'beads-station.skin'

function loadInitial(): Skin {
  try {
    const persisted = localStorage.getItem(STORAGE_KEY)
    if (persisted === 'terminal' || persisted === 'designer') return persisted
  } catch {
    /* non-browser */
  }
  try {
    if (new URLSearchParams(location.search).get('ui') === 'designer') {
      return 'designer'
    }
  } catch {
    /* non-browser */
  }
  return 'terminal'
}

let state: Skin = loadInitial()
const listeners = new Set<() => void>()

function emit(): void {
  try {
    ;(window as unknown as { __bsSkin?: Skin }).__bsSkin = state
  } catch {
    /* non-browser */
  }
  listeners.forEach(l => l())
}

export function subscribeSkin(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): Skin {
  return state
}

try {
  ;(window as unknown as { __bsSkin?: Skin }).__bsSkin = state
} catch {
  /* noop */
}

export function useSkin(): Skin {
  return useSyncExternalStore(subscribeSkin, getSnapshot, getSnapshot)
}

export function getSkin(): Skin {
  return state
}

export function setSkin(s: Skin): void {
  if (state === s) return
  state = s
  try {
    localStorage.setItem(STORAGE_KEY, s)
  } catch {
    /* noop */
  }
  emit()
}

export function toggleSkin(): void {
  setSkin(state === 'terminal' ? 'designer' : 'terminal')
}
