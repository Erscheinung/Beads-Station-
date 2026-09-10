import { useSyncExternalStore } from 'react'

export interface SessionPreferences {
  askBeforeResume: boolean
}

const STORAGE_KEY = 'beads-station.session-preferences'
const DEFAULTS: SessionPreferences = { askBeforeResume: true }

function load(): SessionPreferences {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<SessionPreferences>
    return { askBeforeResume: parsed.askBeforeResume !== false }
  } catch {
    return { ...DEFAULTS }
  }
}

let state = load()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): SessionPreferences {
  return state
}

export function useSessionPreferences(): SessionPreferences {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function setSessionPreferences(next: Partial<SessionPreferences>): void {
  const updated = { ...state, ...next }
  if (updated.askBeforeResume === state.askBeforeResume) return
  state = updated
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* optional */ }
  listeners.forEach(listener => listener())
}

export function claudeResumeKey(bridge: string): string {
  return `bs.claude.session:${bridge}`
}

export function observedClaudeSession(bridge: string): string | null {
  try {
    const value = localStorage.getItem(claudeResumeKey(bridge))
    return value?.trim() ? value : null
  } catch {
    return null
  }
}

export function clearObservedClaudeSession(bridge: string): void {
  try { localStorage.removeItem(claudeResumeKey(bridge)) } catch { /* optional */ }
}

/** Arguments for claude_start derived solely from a provider-observed id. */
export function claudeStartSession(bridge: string): { sessionId: string; resume: boolean } {
  const sessionId = observedClaudeSession(bridge)
  return { sessionId: sessionId ?? '', resume: sessionId !== null }
}
