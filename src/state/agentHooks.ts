// Agent CLI command lines, and the Claude Code hooks that make a pane's
// "waiting for you" signal and session id exact (src-tauri/src/agent_hooks.rs).
//
// Sessions the app starts get the hooks through `claude --settings <file>`.
// For `claude` typed by hand the user can add them to their own settings from
// Settings → Notifications.

import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { shellQuote } from '../lib/shellQuote'

export type AgentCli = 'claude' | 'codex'
export const AGENT_CLI_LABEL: Record<AgentCli, string> = { claude: 'Claude', codex: 'Codex' }

export interface AgentHooksState {
  /** The hooks are in the user's own `~/.claude/settings.json`. */
  installed: boolean
  /** Settings file passed to sessions the app starts; null until the backend has answered. */
  sessionSettings: string | null
  error: string | null
}

let state: AgentHooksState = { installed: false, sessionSettings: null, error: null }
const listeners = new Set<() => void>()
function set(next: Partial<AgentHooksState>) {
  state = { ...state, ...next }
  listeners.forEach(listener => listener())
}

function apply(status: { installed?: boolean; sessionSettings?: string } | null) {
  set({ installed: status?.installed === true, sessionSettings: typeof status?.sessionSettings === 'string' ? status.sessionSettings : null, error: null })
}

let loading: Promise<void> | null = null
/** Read the hook status once. Reads a file; starts nothing. */
export function loadAgentHooks(): Promise<void> {
  loading ??= invoke<{ installed: boolean; sessionSettings: string }>('agent_hooks_status')
    .then(apply)
    .catch(error => set({ error: String(error) }))
  return loading
}

export async function setAgentHooksInstalled(installed: boolean): Promise<void> {
  try {
    apply(await invoke('agent_hooks_set_installed', { installed }))
  } catch (error) {
    set({ error: String(error) })
  }
}

export function useAgentHooks(): AgentHooksState {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => state, () => state)
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isAgentSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value)
}

// Codex can announce a finished turn itself; OSC 9 is one of the sequences a pane reads.
const CODEX_SIGNALS = '-c tui.notifications=true -c tui.notification_method=osc9'

function claudeBase(sessionSettings: string | null): string {
  return sessionSettings ? `claude --settings ${shellQuote(sessionSettings)}` : 'claude'
}

/** Command line that starts an agent CLI in a pane, optionally on a first prompt. */
export function agentStartCommand(cli: AgentCli, prompt: string | null = null, sessionSettings = state.sessionSettings): string {
  const base = cli === 'claude' ? claudeBase(sessionSettings) : `codex ${CODEX_SIGNALS}`
  return prompt ? `${base} ${shellQuote(prompt)}` : base
}

/**
 * Command line that reopens a pane's conversation: the exact session when it
 * is known, otherwise the latest one for the folder. Reopening loads the local
 * transcript; no model turn starts until a prompt is sent.
 */
export function agentResumeCommand(cli: AgentCli, sessionId?: string | null, sessionSettings = state.sessionSettings): string {
  const exact = isAgentSessionId(sessionId) ? sessionId : null
  if (cli === 'claude') return `${claudeBase(sessionSettings)} ${exact ? `--resume ${exact}` : '--continue'}`
  return `codex resume ${exact ?? '--last'} ${CODEX_SIGNALS}`
}

export function __setAgentHooksForTest(next: Partial<AgentHooksState>) { set(next) }
