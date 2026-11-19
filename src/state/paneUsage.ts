// Live usage of the agent session in each terminal pane (Code-7xc.1).
//
// Two sources, merged per pane:
// - Claude Code's status line, forwarded by the Beads Station wrapper as
//   `OSC 7770;usage;claude;{json}` (agent_hooks.rs): context % and the 5-hour
//   and weekly limits, exactly as Claude reports them.
// - The CLI's own session file (session_usage.rs): token totals, subagents,
//   the newest context size and, for Codex, its rate-limit windows.
//
// In memory only, keyed by pane id (terminal panes and the Designer session
// pane alike); it changes too often to live on the persisted pane tree. Unknown
// stays unknown: every number is null until a source has said it. Nothing here
// starts an agent or a model turn.
//
// A follow-up (handoff before the context or 5-hour window runs out) reads
// this through getPaneUsage / subscribePaneUsage.

import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { formatTokens, pace, type LimitWindow } from '../components/designer/transcripts'
import { isAgentSessionId } from './agentHooks'

export type UsageProvider = 'claude' | 'codex' | 'gemini'
export const USAGE_PROVIDER_LABEL: Record<UsageProvider, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }

export interface TokenCounts { input: number; output: number; cacheRead: number; cacheCreate: number }

export interface PaneUsage {
  provider: UsageProvider
  sessionId: string | null
  /** Context used, 0–100, as the CLI reports it or computed from tokens and window. */
  contextPercent: number | null
  /** Tokens in the context at the newest turn. */
  contextTokens: number | null
  contextWindow: number | null
  /** The main session's tokens so far. */
  tokens: TokenCounts | null
  subagents: number
  subagentTokens: TokenCounts | null
  fiveHour: LimitWindow | null
  weekly: LimitWindow | null
  /** When the limit windows were read (ms). */
  limitsAt: number | null
  updatedAt: number
}

/** What one usage report from Claude's status line carries. Any field may be missing. */
export interface StatuslineUsage {
  sessionId: string | null
  contextPercent: number | null
  contextWindow: number | null
  fiveHour: LimitWindow | null
  weekly: LimitWindow | null
}

const FIVE_HOURS = 300
const WEEK = 10080

function finite(value: unknown): number | null {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) ? number : null
}

/** Unix seconds from a number (seconds or milliseconds) or an ISO date. */
function resetSeconds(value: unknown): number | null {
  if (typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value.trim())) {
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? Math.round(ms / 1000) : null
  }
  const number = finite(value)
  if (number === null || number <= 0) return null
  return number > 1e12 ? Math.round(number / 1000) : number
}

function limitWindow(value: unknown, windowMinutes: number): LimitWindow | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const usedPercent = finite(record.used_percentage ?? record.usedPercent)
  const resetsAt = resetSeconds(record.resets_at ?? record.resetsAt)
  if (usedPercent === null || resetsAt === null) return null
  return { usedPercent, windowMinutes, resetsAt }
}

function decodeBase64(text: string): string | null {
  try {
    const binary = atob(text)
    return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)))
  } catch {
    return null
  }
}

/**
 * The payload of an `OSC 7770` usage report (`usage;claude;<json>`), or null
 * when it is not one. The JSON may also arrive base64-encoded. Any program in
 * the terminal can print this, so it is parsed defensively and carries numbers only.
 */
export function parseUsageReport(data: string): StatuslineUsage | null {
  const [kind, cli, ...rest] = data.split(';')
  if (kind !== 'usage' || cli !== 'claude') return null
  const body = rest.join(';').trim()
  if (!body || body.length > 16 * 1024) return null
  const text = body.startsWith('{') ? body : decodeBase64(body)
  if (!text) return null
  let json: unknown
  try { json = JSON.parse(text) } catch { return null }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const record = json as Record<string, unknown>
  // The wrapper flattens; Claude's own shape nests. Accept both.
  const context = (record.context_window && typeof record.context_window === 'object' ? record.context_window : record) as Record<string, unknown>
  const limits = (record.rate_limits && typeof record.rate_limits === 'object' ? record.rate_limits : record) as Record<string, unknown>
  const percent = finite(context.used_percentage)
  const usage: StatuslineUsage = {
    sessionId: isAgentSessionId(record.session_id) ? record.session_id : null,
    contextPercent: percent === null ? null : Math.min(100, Math.max(0, percent)),
    contextWindow: finite(context.context_window_size),
    fiveHour: limitWindow(limits.five_hour, FIVE_HOURS),
    weekly: limitWindow(limits.seven_day, WEEK),
  }
  return usage
}

// ---------- store ----------

const usages = new Map<string, PaneUsage>()
const listeners = new Set<() => void>()
function emit() { listeners.forEach(listener => listener()) }

export function getPaneUsage(paneId: string): PaneUsage | null {
  return usages.get(paneId) ?? null
}

/** Every pane's usage, for watchers that act across panes (the handoff trigger). */
export function paneUsageEntries(): [string, PaneUsage][] {
  return [...usages.entries()]
}

export function subscribePaneUsage(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function usePaneUsage(paneId: string | null): PaneUsage | null {
  return useSyncExternalStore(subscribePaneUsage, () => (paneId ? getPaneUsage(paneId) : null), () => null)
}

function empty(provider: UsageProvider, sessionId: string | null): PaneUsage {
  return { provider, sessionId, contextPercent: null, contextTokens: null, contextWindow: null, tokens: null, subagents: 0, subagentTokens: null, fiveHour: null, weekly: null, limitsAt: null, updatedAt: Date.now() }
}

function put(paneId: string, next: PaneUsage) {
  usages.set(paneId, next)
  emit()
}

/**
 * Which agent (and session) runs in a pane, from the foreground poll or a
 * report. A different provider or session starts from nothing: the old
 * numbers belong to the old session. Null means no agent there any more.
 */
export function notePaneAgent(paneId: string, provider: UsageProvider | null, sessionId: string | null = null): void {
  const current = usages.get(paneId)
  if (!provider) {
    if (current) { usages.delete(paneId); emit() }
    return
  }
  const id = sessionId && sessionId.length <= 80 ? sessionId : null
  if (!current || current.provider !== provider) { put(paneId, empty(provider, id)); return }
  if (id && current.sessionId !== id) {
    // Account-wide limits outlive a session (Codex /new, Claude /clear); context and totals do not.
    put(paneId, { ...empty(provider, id), fiveHour: current.fiveHour, weekly: current.weekly, limitsAt: current.limitsAt })
  }
}

/** A report from Claude's status line: the most direct source there is. */
export function applyStatuslineUsage(paneId: string, report: StatuslineUsage): void {
  notePaneAgent(paneId, 'claude', report.sessionId)
  const current = usages.get(paneId)!
  const now = Date.now()
  put(paneId, {
    ...current,
    contextPercent: report.contextPercent ?? current.contextPercent,
    contextWindow: report.contextWindow ?? current.contextWindow,
    fiveHour: report.fiveHour ?? current.fiveHour,
    weekly: report.weekly ?? current.weekly,
    limitsAt: report.fiveHour || report.weekly ? now : current.limitsAt,
    updatedAt: now,
  })
}

interface FileUsage {
  provider: UsageProvider
  sessionId: string | null
  usage: TokenCounts | null
  subagents: number
  subagentUsage: TokenCounts | null
  contextTokens: number | null
  contextWindow: number | null
  limits: { primary: LimitWindow | null; secondary: LimitWindow | null; observedAt: string | null } | null
}

const lastRead = new Map<string, { key: string; at: number }>()
const inFlight = new Set<string>()
// The session file is re-read at most this often per pane; a changed session is read at once.
const FILE_REFRESH_MS = 15_000

/** Merge what the session file says into the pane's usage. */
export function applyFileUsage(paneId: string, file: FileUsage): void {
  const current = usages.get(paneId)
  if (!current || current.provider !== file.provider) return
  if (current.sessionId && file.sessionId && current.sessionId !== file.sessionId) return
  const now = Date.now()
  const limits = file.limits
  const observed = limits?.observedAt ? Date.parse(limits.observedAt) : NaN
  put(paneId, {
    ...current,
    sessionId: current.sessionId ?? (isAgentSessionId(file.sessionId) ? file.sessionId : null),
    tokens: file.usage ?? current.tokens,
    subagents: file.subagents ?? current.subagents,
    subagentTokens: file.subagentUsage ?? current.subagentTokens,
    contextTokens: file.contextTokens ?? current.contextTokens,
    // Claude's status line knows the real window (200k or 1M); the file does not say.
    contextWindow: current.contextWindow ?? file.contextWindow,
    fiveHour: limits?.primary ?? current.fiveHour,
    weekly: limits?.secondary ?? current.weekly,
    limitsAt: limits?.primary || limits?.secondary ? (Number.isFinite(observed) ? observed : now) : current.limitsAt,
    updatedAt: now,
  })
}

/** Read the pane's session file, at most every few seconds. Reads files only. */
export function refreshPaneUsage(paneId: string, cwd: string | null = null, force = false): void {
  const current = usages.get(paneId)
  if (!current) return
  if (current.provider !== 'gemini' && !current.sessionId) return
  const key = `${current.provider}:${current.sessionId ?? ''}`
  const last = lastRead.get(paneId)
  if (!force && last && last.key === key && Date.now() - last.at < FILE_REFRESH_MS) return
  if (inFlight.has(paneId)) return
  inFlight.add(paneId)
  lastRead.set(paneId, { key, at: Date.now() })
  void invoke<FileUsage | null>('session_usage', { provider: current.provider, sessionId: current.sessionId, cwd })
    .then(file => { if (file) applyFileUsage(paneId, file) })
    .catch(() => { /* no file yet, or a backend without the command */ })
    .finally(() => inFlight.delete(paneId))
}

export function clearPaneUsage(paneId: string): void {
  lastRead.delete(paneId)
  if (usages.delete(paneId)) emit()
}

// ---------- text ----------

/** Context use 0–100, or null when neither the CLI nor tokens-and-window say. */
export function contextPercent(usage: PaneUsage): number | null {
  if (usage.contextPercent !== null) return usage.contextPercent
  if (usage.contextTokens !== null && usage.contextWindow) return Math.min(100, (usage.contextTokens / usage.contextWindow) * 100)
  return null
}

/** `Claude · ctx 42% · 180k (+2 subagents)`, or null when nothing is known. */
export function usageChipText(usage: PaneUsage | null): string | null {
  if (!usage) return null
  const parts: string[] = []
  const percent = contextPercent(usage)
  if (percent !== null) parts.push(`ctx ${Math.round(percent)}%`)
  if (usage.contextTokens !== null) parts.push(formatTokens(usage.contextTokens))
  else if (percent === null && usage.tokens) parts.push(`${formatTokens(usage.tokens.input + usage.tokens.cacheCreate)} in · ${formatTokens(usage.tokens.output)} out`)
  if (parts.length === 0) return null
  const subagents = usage.subagents > 0 ? ` (+${usage.subagents} subagent${usage.subagents === 1 ? '' : 's'})` : ''
  return `${USAGE_PROVIDER_LABEL[usage.provider]} · ${parts.join(' · ')}${subagents}`
}

function tokenLine(label: string, tokens: TokenCounts): string {
  return `${label}: ${formatTokens(tokens.input + tokens.cacheCreate)} in · ${formatTokens(tokens.cacheRead)} cached · ${formatTokens(tokens.output)} out`
}

export function usageTooltip(usage: PaneUsage, nowSeconds = Date.now() / 1000): string {
  const lines: string[] = []
  const percent = contextPercent(usage)
  if (usage.contextTokens !== null || percent !== null) {
    const tokens = usage.contextTokens !== null ? `${formatTokens(usage.contextTokens)} tokens` : null
    const window = usage.contextWindow ? `of ${formatTokens(usage.contextWindow)}` : null
    lines.push(['Context:', tokens, window, percent !== null ? `(${Math.round(percent)}%)` : null].filter(Boolean).join(' '))
  }
  if (usage.tokens) lines.push(tokenLine('This session', usage.tokens))
  if (usage.subagents > 0) lines.push(usage.subagentTokens ? tokenLine(`${usage.subagents} subagent${usage.subagents === 1 ? '' : 's'}`, usage.subagentTokens) : `${usage.subagents} subagents, usage not recorded`)
  const limits = limitsText(usage, nowSeconds)
  if (limits) lines.push(`Limits: ${limits.text}${limits.stale ? ' (old reading)' : ''}`)
  lines.push('Read from the CLI itself and its session file. Unknown numbers are left out.')
  return lines.join('\n')
}

/** Limit readings older than this are marked as such. */
const STALE_LIMITS_MS = 15 * 60 * 1000

function clock(seconds: number): string {
  const date = new Date(seconds * 1000)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** `5h 81% · wk 69% · resets 14:20`, or null when no limit is known. */
export function limitsText(usage: PaneUsage | null, nowSeconds = Date.now() / 1000): { text: string; stale: boolean } | null {
  if (!usage || (!usage.fiveHour && !usage.weekly)) return null
  const parts: string[] = []
  let stale = usage.limitsAt !== null && nowSeconds * 1000 - usage.limitsAt > STALE_LIMITS_MS
  let reset: number | null = null
  for (const [label, window] of [['5h', usage.fiveHour], ['wk', usage.weekly]] as const) {
    if (!window) continue
    const reading = pace(window, nowSeconds)
    if (reading.status === 'reset') { parts.push(`${label} reset`); stale = true; continue }
    parts.push(`${label} ${Math.round(reading.used)}%`)
    reset ??= window.resetsAt
  }
  if (reset !== null) parts.push(`resets ${clock(reset)}`)
  return { text: parts.join(' · '), stale }
}

export function __resetPaneUsageForTest() {
  usages.clear()
  lastRead.clear()
  inFlight.clear()
  emit()
}
