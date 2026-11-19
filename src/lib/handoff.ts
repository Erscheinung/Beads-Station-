// Offline handoff note (Code-7xc.2). Pure: builds markdown from what Beads
// Station already knows. No model is asked for anything; nothing here starts an
// agent. The runner (handoffRunner.ts) gathers the inputs and writes the file.

import { contextPercent, USAGE_PROVIDER_LABEL, type PaneUsage, type UsageProvider } from '../state/paneUsage'
import { mentionsBead } from '../components/designer/transcripts'

export interface HandoffTodo { text: string; status: string }

/** What the session file says (handoff_collect). */
export interface HandoffFacts {
  firstPrompt: string | null
  recentPrompts: string[]
  todos: HandoffTodo[]
  truncated: boolean
}

export interface HandoffChange { path: string; kind: string; added: number; removed: number }

export type HandoffReason = 'context' | 'five-hour' | 'manual'

export interface HandoffInput {
  now: Date
  workspaceName: string
  workspacePath: string
  provider: UsageProvider
  sessionId: string | null
  usage: Pick<PaneUsage, 'contextPercent' | 'contextTokens' | 'contextWindow' | 'fiveHour' | 'weekly'> | null
  reason: HandoffReason
  /** Null when the session file could not be read. */
  facts: HandoffFacts | null
  /** Null when changed files could not be listed. */
  changes: HandoffChange[] | null
  /** Ticket ids the workspace knows; any named in a prompt is listed. */
  beadIds: string[]
  resumeCommand: string | null
}

/** `<home folder>/x` becomes `~/x`; nothing else is touched. */
export function tildePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
}

function pad(n: number) { return String(n).padStart(2, '0') }

export function handoffFileStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A fence one backtick longer than any run inside the text, so a prompt containing ``` stays intact. */
function fenced(text: string, lang = ''): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}${lang}\n${text}\n${fence}`
}

function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? 'unknown' : `${Math.round(value)}%`
}

function resetClock(seconds: number): string {
  const date = new Date(seconds * 1000)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const REASON_TEXT: Record<HandoffReason, string> = {
  context: 'the context window was nearly full',
  'five-hour': 'the 5-hour usage limit was nearly used up',
  manual: 'saved on request',
}

export function buildHandoffMarkdown(input: HandoffInput): string {
  const { usage, facts } = input
  const label = USAGE_PROVIDER_LABEL[input.provider]
  const lines: string[] = []
  lines.push(`# Handoff: ${input.workspaceName} (${label})`, '')
  lines.push(`Created ${handoffFileStamp(input.now)} because ${REASON_TEXT[input.reason]}. Written by Beads Station from the session file; no model was asked.`, '')

  lines.push('## Where', '')
  lines.push(`- Workspace: \`${tildePath(input.workspacePath)}\``)
  lines.push(`- Agent: ${label}, session \`${input.sessionId ?? 'unknown'}\``)
  const prompts = [facts?.firstPrompt ?? '', ...(facts?.recentPrompts ?? [])].filter(Boolean)
  const tickets = input.beadIds.filter(id => prompts.some(firstPrompt => mentionsBead({ firstPrompt }, id)))
  lines.push(`- Ticket: ${tickets.length ? tickets.map(id => `\`${id}\``).join(', ') : 'none named in the prompts'}`)
  lines.push('')

  lines.push('## Usage when saved', '')
  const ctx = usage ? contextPercent(usage as PaneUsage) : null
  lines.push(`- Context: ${percent(ctx)}${usage?.contextTokens != null && usage.contextWindow ? ` (${usage.contextTokens.toLocaleString('en-US')} of ${usage.contextWindow.toLocaleString('en-US')} tokens)` : ''}`)
  lines.push(`- 5-hour limit: ${percent(usage?.fiveHour?.usedPercent)}${usage?.fiveHour ? `, resets ${resetClock(usage.fiveHour.resetsAt)}` : ''}`)
  lines.push(`- Weekly limit: ${percent(usage?.weekly?.usedPercent)}${usage?.weekly ? `, resets ${resetClock(usage.weekly.resetsAt)}` : ''}`)
  lines.push('')

  lines.push('## Goal (first prompt)', '')
  lines.push(facts?.firstPrompt ? fenced(facts.firstPrompt) : facts ? '_Not found in the session file._' : '_Unknown: the session file could not be read._')
  if (facts?.truncated) lines.push('', '_The session is long; only its newest part was read for the items below._')
  lines.push('')

  lines.push('## Recent prompts (oldest first)', '')
  if (!facts) lines.push('_Unknown: the session file could not be read._')
  else if (facts.recentPrompts.length === 0) lines.push('_None found._')
  else facts.recentPrompts.forEach((prompt, index) => { lines.push(`### ${index + 1}`, '', fenced(prompt), '') })
  if (lines[lines.length - 1] !== '') lines.push('')

  lines.push('## Plan / todo list', '')
  if (!facts) lines.push('_Unknown: the session file could not be read._')
  else if (facts.todos.length === 0) lines.push('_The agent had not written one._')
  else for (const todo of facts.todos) lines.push(`- [${todo.status === 'completed' ? 'x' : ' '}] ${todo.text.replace(/\n+/g, ' ')}${todo.status === 'in_progress' ? ' (in progress)' : ''}`)
  lines.push('')

  lines.push('## Changed files', '')
  if (input.changes === null) lines.push('_Unknown: the workspace could not be read._')
  else if (input.changes.length === 0) lines.push('_No uncommitted changes._')
  else for (const change of input.changes.slice(0, 60)) lines.push(`- \`${tildePath(change.path)}\` ${change.kind} (+${change.added} -${change.removed})`)
  if (input.changes && input.changes.length > 60) lines.push(`- and ${input.changes.length - 60} more`)
  lines.push('')

  lines.push('## Continue', '')
  if (input.resumeCommand) {
    lines.push('Resume this exact conversation (it keeps its history, and starts a model turn only when you send a message):', '', fenced(input.resumeCommand, 'sh'), '')
    lines.push('Or start a fresh session and paste the goal, the plan and the last prompt above.')
  } else {
    lines.push('Start a fresh session and paste the goal, the plan and the last prompt above. No resume command is known for this agent.')
  }
  lines.push('')
  return lines.join('\n')
}

// ---------- when to save ----------

export interface HandoffDue { reason: Exclude<HandoffReason, 'manual'>; key: string }

/** Limit readings older than this say nothing about now. */
const FRESH_LIMITS_MS = 15 * 60 * 1000

/**
 * Which automatic handoffs a pane's usage calls for. Each has a key: one note
 * per session and context window, one per session and 5-hour reset time.
 * Unknown numbers never trigger. A threshold of 0 means off.
 */
export function handoffsDue(usage: PaneUsage | null, threshold: number, now = Date.now()): HandoffDue[] {
  if (!usage || threshold <= 0 || !usage.sessionId || usage.provider === 'gemini') return []
  const due: HandoffDue[] = []
  const ctx = contextPercent(usage)
  if (ctx !== null && ctx >= threshold) due.push({ reason: 'context', key: `${usage.provider}:${usage.sessionId}:ctx` })
  const window = usage.fiveHour
  if (window && window.usedPercent >= threshold && window.resetsAt * 1000 > now && usage.limitsAt !== null && now - usage.limitsAt <= FRESH_LIMITS_MS) {
    due.push({ reason: 'five-hour', key: `${usage.provider}:${usage.sessionId}:5h:${window.resetsAt}` })
  }
  return due
}

const LEDGER_KEY = 'bs.handoff.written'
const LEDGER_MAX = 300

/** Which handoffs were written, kept in memory and (best effort) in localStorage so a restart does not write them again. */
export class HandoffLedger {
  private keys: Set<string>
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage) {
    this.keys = new Set()
    try {
      const parsed = JSON.parse(storage?.getItem(LEDGER_KEY) ?? '[]')
      if (Array.isArray(parsed)) parsed.filter((k): k is string => typeof k === 'string').forEach(k => this.keys.add(k))
    } catch { /* start empty */ }
  }
  has(key: string): boolean { return this.keys.has(key) }
  add(key: string): void {
    this.keys.add(key)
    const kept = [...this.keys].slice(-LEDGER_MAX)
    this.keys = new Set(kept)
    try { this.storage?.setItem(LEDGER_KEY, JSON.stringify(kept)) } catch { /* memory only */ }
  }
  remove(key: string): void {
    this.keys.delete(key)
    try { this.storage?.setItem(LEDGER_KEY, JSON.stringify([...this.keys])) } catch { /* memory only */ }
  }
}

/**
 * Decides when a pane's usage has crossed the line and hands it to `save`,
 * once per key. A key is claimed before saving (so a burst of updates writes
 * once) and released if saving fails (so it can be tried again).
 */
export class HandoffTrigger {
  constructor(private readonly deps: {
    threshold: () => number
    ledger: HandoffLedger
    save: (paneId: string, reason: HandoffDue['reason']) => Promise<boolean>
    now?: () => number
  }) {}

  check(paneId: string, usage: PaneUsage | null): void {
    const due = handoffsDue(usage, this.deps.threshold(), this.deps.now?.() ?? Date.now()).filter(item => !this.deps.ledger.has(item.key))
    if (due.length === 0) return
    // One note covers every reason that is due right now.
    due.forEach(item => this.deps.ledger.add(item.key))
    void this.deps.save(paneId, due[0].reason).then(ok => { if (!ok) due.forEach(item => this.deps.ledger.remove(item.key)) }, () => due.forEach(item => this.deps.ledger.remove(item.key)))
  }
}
