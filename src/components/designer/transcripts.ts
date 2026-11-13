// Designer Desk (Code-05b.1): read-only history of agent sessions.
// The Rust side (transcripts.rs) parses the CLIs' own session files; this file
// holds the shapes, the invoke wrappers and the small pure helpers the views use.

import { invoke } from '@tauri-apps/api/core'

export type TranscriptProvider = 'claude' | 'codex'

export interface TranscriptSummary {
  id: string
  provider: TranscriptProvider
  title: string
  /** The opening prompt, clipped. Ticket sessions open with the ticket id. */
  firstPrompt: string
  modifiedMs: number
  bytes: number
}

export type TranscriptBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; summary: string; result: string | null }

export interface TranscriptTurn {
  role: 'user' | 'assistant'
  at: string | null
  blocks: TranscriptBlock[]
  files: string[]
  thinking: number
}

export interface TranscriptUsage { input: number; output: number; cacheRead: number; cacheCreate: number }

export interface Transcript {
  id: string
  provider: TranscriptProvider
  turns: TranscriptTurn[]
  truncated: boolean
  usage: TranscriptUsage | null
}

export function listTranscripts(workspacePath: string): Promise<TranscriptSummary[]> {
  return invoke<TranscriptSummary[]>('transcripts_list', { workspacePath })
}

export function readTranscript(workspacePath: string, provider: TranscriptProvider, sessionId: string): Promise<Transcript> {
  return invoke<Transcript>('transcript_read', { workspacePath, provider, sessionId })
}

/** Every piece of text in a turn that search should look at. */
export function turnText(turn: TranscriptTurn): string {
  return turn.blocks
    .map(block => block.kind === 'text' ? block.text : `${block.name} ${block.summary}`)
    .concat(turn.files)
    .join('\n')
}

/** Turns that contain every word of the query, case-insensitively. An empty query keeps all. */
export function filterTurns(turns: TranscriptTurn[], query: string): TranscriptTurn[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return turns
  return turns.filter(turn => {
    const text = turnText(turn).toLowerCase()
    return words.every(word => text.includes(word))
  })
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 10_000 ? 0 : 1)}k`
  return String(count)
}

/**
 * One honest line about a session's size. Cache reads are shown apart because
 * they dwarf everything else and are billed differently; no cost is claimed.
 */
export function usageLine(usage: TranscriptUsage | null): string {
  if (!usage) return 'Usage not recorded for this session'
  const fresh = usage.input + usage.cacheCreate
  return `${formatTokens(fresh)} new in · ${formatTokens(usage.output)} out · ${formatTokens(usage.cacheRead)} cached`
}

export function relativeTime(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days < 30 ? `${days}d ago` : new Date(ms).toLocaleDateString()
}

/** Text worth pinning from a turn: its prose, without tool plumbing. */
export function turnProse(turn: TranscriptTurn): string {
  return turn.blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('\n\n')
}

// ---------- Meter (Code-05b.3) ----------

export interface LimitWindow { usedPercent: number; windowMinutes: number; resetsAt: number }
export interface CodexLimits { plan: string | null; primary: LimitWindow | null; secondary: LimitWindow | null; observedAt: string | null }
export interface DayUsage { day: string; input: number; output: number; cacheRead: number; cacheCreate: number }
export interface Meter { codex: CodexLimits | null; claudeDays: DayUsage[]; incomplete: boolean }

export function readMeter(): Promise<Meter> {
  return invoke<Meter>('meter_summary')
}

export type PaceStatus = 'ahead' | 'on-pace' | 'under' | 'reset'
export interface Pace { used: number; elapsed: number; status: PaceStatus; resetsIn: string }

/**
 * Where a limit window stands against an even burn. `elapsed` is how far
 * through the window we are; using more than that (plus a margin) is "ahead".
 * A window whose reset time has passed since the reading was written is
 * reported as reset: the old percentage no longer means anything.
 */
export function pace(window: LimitWindow, nowSeconds = Date.now() / 1000): Pace {
  const total = window.windowMinutes * 60
  const remaining = window.resetsAt - nowSeconds
  if (remaining <= 0) return { used: 0, elapsed: 0, status: 'reset', resetsIn: 'reset since last reading' }
  const elapsed = Math.min(100, Math.max(0, ((total - remaining) / total) * 100))
  const used = Math.min(100, Math.max(0, window.usedPercent))
  const status: PaceStatus = used > elapsed + 8 ? 'ahead' : used < elapsed - 8 ? 'under' : 'on-pace'
  return { used, elapsed, status, resetsIn: `resets in ${duration(remaining)}` }
}

function duration(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${Math.max(1, minutes)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${minutes % 60}m`
  return `${Math.round(hours / 24)}d`
}

export function windowLabel(minutes: number): string {
  return minutes % 1440 === 0 ? (minutes === 10080 ? 'Weekly' : `${minutes / 1440}-day`) : `${Math.round(minutes / 60)}-hour`
}

// ---------- Bead <-> session links (Code-05b.4) ----------

/** A session worked a ticket when its opening prompt names the ticket id as a whole word. */
export function mentionsBead(summary: Pick<TranscriptSummary, 'firstPrompt'>, beadId: string): boolean {
  if (!beadId) return false
  const escaped = beadId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Not followed by an id character or by ".<word>": a child id (Code-1.2) is not its parent (Code-1).
  return new RegExp(`(^|[^\\w-])${escaped}(?![\\w-])(?!\\.\\w)`).test(summary.firstPrompt)
}

// The ticket page asks History to open a particular session. Kept outside React
// so it survives the view switch.
const focusRequests = new Map<string, string>()
export function requestHistoryFocus(workspaceId: string, summary: Pick<TranscriptSummary, 'provider' | 'id'>) {
  focusRequests.set(workspaceId, `${summary.provider}:${summary.id}`)
}
export function takeHistoryFocus(workspaceId: string): string | null {
  const key = focusRequests.get(workspaceId) ?? null
  focusRequests.delete(workspaceId)
  return key
}
