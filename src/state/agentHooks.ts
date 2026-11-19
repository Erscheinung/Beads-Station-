// Agent CLI command lines, and the Claude Code hooks that make a pane's
// "waiting for you" signal and session id exact (src-tauri/src/agent_hooks.rs).
//
// Sessions the app starts get the hooks through `claude --settings <file>`.
// For `claude` typed by hand the user can add them to their own settings from
// Settings → Notifications.

import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { shellQuote } from '../lib/shellQuote'
import { agentLaunchCommand } from './sessionPreferences'

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

// The user's own command for each CLI (Settings → Sessions): an alias such as
// `ccd` works because the line is typed into an interactive shell.
function claudeBase(sessionSettings: string | null): string {
  const claude = agentLaunchCommand('claude')
  return sessionSettings ? `${claude} --settings ${shellQuote(sessionSettings)}` : claude
}

/** Command line that starts an agent CLI in a pane, optionally on a first prompt. */
export function agentStartCommand(cli: AgentCli, prompt: string | null = null, sessionSettings = state.sessionSettings): string {
  const base = cli === 'claude' ? claudeBase(sessionSettings) : `${agentLaunchCommand('codex')} ${CODEX_SIGNALS}`
  return prompt ? `${base} ${shellQuote(prompt)}` : base
}

/**
 * Command line that reopens a pane's conversation: the exact session when it
 * is known, otherwise the latest one for the folder. With `prompt`, the message
 * the user wrote on the restored pane is sent as the first thing after reopening.
 * What reopening alone costs has not been measured; do not claim it is free.
 */
export function agentResumeCommand(cli: AgentCli, sessionId?: string | null, sessionSettings = state.sessionSettings, prompt: string | null = null): string {
  const exact = isAgentSessionId(sessionId) ? sessionId : null
  const message = prompt?.trim() ? ` ${shellQuote(prompt.trim())}` : ''
  if (cli === 'claude') return `${claudeBase(sessionSettings)} ${exact ? `--resume ${exact}` : '--continue'}${message}`
  return `${agentLaunchCommand('codex')} resume ${exact ?? '--last'} ${CODEX_SIGNALS}${message}`
}

/**
 * Command line that forks a conversation into a new session. Both CLIs fork the
 * whole session (Claude has no fork-at-message); the original stays untouched.
 * Null without an exact, valid session id: a fork of "the latest" would be a guess.
 * Uses the user's own launch command (Settings → Sessions), like resume.
 */
export function agentForkCommand(cli: AgentCli, sessionId: string | null | undefined, sessionSettings = state.sessionSettings): string | null {
  if (!isAgentSessionId(sessionId)) return null
  if (cli === 'claude') return `${claudeBase(sessionSettings)} --resume ${sessionId} --fork-session`
  return `${agentLaunchCommand('codex')} fork ${sessionId} ${CODEX_SIGNALS}`
}

export function __setAgentHooksForTest(next: Partial<AgentHooksState>) { set(next) }
