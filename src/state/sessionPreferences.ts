import { useSyncExternalStore } from 'react'
import { persistDurableUserConfigKey } from '../lib/durableUserConfig'

export interface SessionPreferences {
  askBeforeResume: boolean
  restoreContextOnLaunch: boolean
  confirmDestructiveActions: boolean
  /** Shells live in a background terminal host and survive quitting the app. */
  keepTerminalsRunning: boolean
  /** Where a started agent lives: a terminal pane, or the bottom chat panel. */
  chatSurface: 'terminal' | 'panel'
  /** What is typed into the pane to start each CLI, flags included. */
  claudeCommand: string
  codexCommand: string
}

const STORAGE_KEY = 'beads-station.session-preferences'
const DEFAULTS: SessionPreferences = { askBeforeResume: true, restoreContextOnLaunch: true, confirmDestructiveActions: true, keepTerminalsRunning: false, chatSurface: 'terminal', claudeCommand: 'claude', codexCommand: 'codex' }

function load(): SessionPreferences {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<SessionPreferences>
    return {
      askBeforeResume: parsed.askBeforeResume !== false,
      restoreContextOnLaunch: parsed.restoreContextOnLaunch !== false,
      confirmDestructiveActions: parsed.confirmDestructiveActions !== false,
      keepTerminalsRunning: parsed.keepTerminalsRunning === true,
      chatSurface: parsed.chatSurface === 'panel' ? 'panel' : 'terminal',
      claudeCommand: typeof parsed.claudeCommand === 'string' ? parsed.claudeCommand : DEFAULTS.claudeCommand,
      codexCommand: typeof parsed.codexCommand === 'string' ? parsed.codexCommand : DEFAULTS.codexCommand,
    }
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
  if ((Object.keys(updated) as (keyof SessionPreferences)[]).every(key => updated[key] === state[key])) return
  state = updated
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* optional */ }
  persistDurableUserConfigKey(STORAGE_KEY)
  listeners.forEach(listener => listener())
}

/** Synchronous boot-time read used before React mounts the workspace stores. */
export function shouldRestoreContextOnLaunch(): boolean {
  return state.restoreContextOnLaunch
}

/** The command line for an agent CLI. An empty setting means the plain CLI. */
export function agentLaunchCommand(provider: 'claude' | 'codex'): string {
  return (provider === 'claude' ? state.claudeCommand : state.codexCommand).trim() || provider
}

/** Synchronous read used when a pane's shell is about to start. */
export function shouldKeepTerminalsRunning(): boolean {
  return state.keepTerminalsRunning
}

export function subscribeSessionPreferences(listener: () => void): () => void {
  return subscribe(listener)
}

/** Synchronous read for lifecycle actions that may arrive outside React. */
export function shouldConfirmDestructiveActions(): boolean {
  return state.confirmDestructiveActions
}

export type ObservedProvider = 'claude' | 'codex'

export function providerSessionKey(provider: ObservedProvider, bridge: string): string {
  return provider === 'claude' ? claudeResumeKey(bridge) : `bs.codex.thread:${bridge}`
}

export function observedProviderSession(provider: ObservedProvider, bridge: string): string | null {
  try {
    const value = localStorage.getItem(providerSessionKey(provider, bridge))
    return value?.trim() ? value.trim() : null
  } catch {
    return null
  }
}

export function rememberObservedProviderSession(provider: ObservedProvider, bridge: string, value: string): void {
  const observed = value.trim()
  if (!observed) return
  try { localStorage.setItem(providerSessionKey(provider, bridge), observed) } catch { /* optional */ }
}

export function clearObservedProviderSession(provider: ObservedProvider, bridge: string): void {
  try { localStorage.removeItem(providerSessionKey(provider, bridge)) } catch { /* optional */ }
}

export function claudeResumeKey(bridge: string): string {
  return `bs.claude.session:${bridge}`
}

export function observedClaudeSession(bridge: string): string | null {
  return observedProviderSession('claude', bridge)
}

export function clearObservedClaudeSession(bridge: string): void {
  clearObservedProviderSession('claude', bridge)
}

/** Arguments for claude_start derived solely from a provider-observed id. */
export function claudeStartSession(bridge: string): { sessionId: string; resume: boolean } {
  const sessionId = observedClaudeSession(bridge)
  return { sessionId: sessionId ?? '', resume: sessionId !== null }
}
