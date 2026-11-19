// Designer Desk (Code-05b.2): the Shelf, an agent-agnostic tray of context.
//
// Anything worth telling an agent can be put here (pasted text, a file, a
// markdown note) and sent into whichever session is running, whatever agent it
// is. Sending only types the text into a terminal; it never presses Enter, so
// nothing reaches a model until the user submits it. Items are kept per
// workspace in the browser store: a convenience, not the system of record.

import { useSyncExternalStore } from 'react'
import { fileUrlToPath } from '../../lib/abbreviatePath'

export type ShelfKind = 'note' | 'file' | 'markdown' | 'folder' | 'link'
const KINDS: ShelfKind[] = ['note', 'file', 'markdown', 'folder', 'link']

export interface ShelfItem {
  id: string
  kind: ShelfKind
  /** Pasted text for a note; an absolute or ~ path for a file, folder or markdown note; a URL for a link. References only: nothing is copied. */
  value: string
  label: string
  addedAt: number
  /** Where it came from, e.g. "Claude session". */
  source?: string
}

const KEY_PREFIX = 'bs.shelf.'
const MAX_ITEMS = 50
/** A markdown note is sent as text; anything bigger is sent as a path instead. */
export const MAX_INLINE_BYTES = 64 * 1024

/** Decide what a pasted string is. One box, no mode switch. */
export function classifyInput(raw: string): { kind: ShelfKind; value: string } | null {
  const text = fileUrlToPath(raw.trim())
  if (!text) return null
  if (isLink(text)) return { kind: 'link', value: text }
  // "/review this" is a slash command, not a path: an absolute path needs a second segment.
  const shaped = text.startsWith('/') ? text.split('/').length >= 3 : /^(~\/|\.{1,2}\/)/.test(text)
  // Spaces are fine when escaped, or when the whole thing ends in a file extension ("/Notes/My Vault/a.md").
  const plain = !/\s/.test(text.replace(/\\ /g, '_')) || /\.\w{1,6}$/.test(text)
  const looksLikePath = !text.includes('\n') && shaped && plain && !/['"]/.test(text)
  if (looksLikePath) {
    return { kind: /\.(md|markdown|mdx|txt)$/i.test(text) ? 'markdown' : 'file', value: unquotePath(text) }
  }
  // A quoted path, as Finder drags and `pbcopy` of a path produce.
  const quoted = /^(['"])(\/[^'"\n]+)\1$/.exec(text)
  if (quoted) return { kind: /\.(md|markdown|mdx|txt)$/i.test(quoted[2]) ? 'markdown' : 'file', value: quoted[2] }
  return { kind: 'note', value: text }
}

function unquotePath(text: string): string {
  return text.replace(/\\ /g, ' ')
}

/** A single http(s) URL, nothing else on the line. */
export function isLink(text: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(text.trim())
}

/** Files the user's editor can show; everything else is opened by the system. */
export function isTextPath(path: string): boolean {
  return /\.(md|markdown|mdx|txt|json|jsonc|ya?ml|toml|ts|tsx|js|jsx|mjs|cjs|css|scss|html|rs|py|go|sh|zsh|swift|java|kt|rb|c|h|cpp|hpp|sql|xml|csv|log|env|ini|conf|lock)$/i.test(path)
}

/** Dropped paths become references; `kinds` says which of them are folders ("dir"). */
export function dropItems(paths: string[], kinds: string[]): { kind: ShelfKind; value: string }[] {
  return paths.flatMap((path, index): { kind: ShelfKind; value: string }[] => {
    if (!path || kinds[index] === 'missing') return []
    if (kinds[index] === 'dir') return [{ kind: 'folder' as const, value: path }]
    return [{ kind: /\.(md|markdown|mdx)$/i.test(path) ? 'markdown' as const : 'file' as const, value: path }]
  })
}

/** What a double-click does with an item. */
export function openAction(item: Pick<ShelfItem, 'kind' | 'value'>): 'browser' | 'editor' | 'system' | 'none' {
  if (item.kind === 'link') return 'browser'
  if (item.kind === 'note') return 'none'
  if (item.kind === 'folder') return 'system'
  return isTextPath(item.value) ? 'editor' : 'system'
}

export function defaultLabel(kind: ShelfKind, value: string): string {
  if (kind === 'note') {
    const first = value.split('\n').find(line => line.trim()) ?? value
    return first.length > 60 ? `${first.slice(0, 60)}…` : first
  }
  if (kind === 'link') return value.replace(/^https?:\/\//i, '').replace(/\/$/, '')
  return value.split('/').filter(Boolean).pop() ?? value
}

/** Quote a path the way a shell and the agents' @-mentions both accept. */
export function quotePath(path: string): string {
  return /^[\w@%+=:,./~-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`
}

/**
 * The text typed into a session for a set of items. Files go in as paths (the
 * agent reads them itself); notes and small markdown files go in as text under
 * a heading, so the agent can tell where each piece came from.
 * `readText` loads a markdown file; it may throw or return null when unreadable.
 */
export async function composePayload(
  items: ShelfItem[],
  readText: (path: string) => Promise<{ content: string; truncated: boolean; binary: boolean } | null>,
): Promise<string> {
  const parts: string[] = []
  for (const item of items) {
    if (item.kind === 'file' || item.kind === 'folder') { parts.push(quotePath(item.value)); continue }
    if (item.kind === 'link') { parts.push(item.value); continue }
    if (item.kind === 'note') { parts.push(`## ${item.label}\n${item.value}`); continue }
    let file: Awaited<ReturnType<typeof readText>> = null
    try { file = await readText(item.value) } catch { file = null }
    parts.push(file && !file.binary && !file.truncated
      ? `## ${item.label}\n${file.content.trim()}`
      : `${quotePath(item.value)}`)
  }
  return parts.join('\n\n')
}

// ---------- per-workspace store ----------

type Listener = () => void
const lists = new Map<string, ShelfItem[]>()
const listeners = new Map<string, Set<Listener>>()
const EMPTY: ShelfItem[] = []

function read(workspaceId: string): ShelfItem[] {
  const cached = lists.get(workspaceId)
  if (cached) return cached
  let items: ShelfItem[] = EMPTY
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY_PREFIX + workspaceId) ?? '[]')
    if (Array.isArray(parsed)) {
      items = parsed.filter((item): item is ShelfItem =>
        item && typeof item.id === 'string' && typeof item.value === 'string' && KINDS.includes(item.kind))
    }
  } catch { /* private window or bad data: start empty */ }
  lists.set(workspaceId, items)
  return items
}

function write(workspaceId: string, items: ShelfItem[]) {
  lists.set(workspaceId, items)
  try { localStorage.setItem(KEY_PREFIX + workspaceId, JSON.stringify(items)) } catch { /* in-memory only */ }
  listeners.get(workspaceId)?.forEach(listener => listener())
}

export function addShelfItem(workspaceId: string, input: { kind: ShelfKind; value: string; label?: string; source?: string }): ShelfItem {
  const items = read(workspaceId)
  const existing = items.find(item => item.kind === input.kind && item.value === input.value)
  if (existing) return existing
  const item: ShelfItem = {
    id: crypto.randomUUID(),
    kind: input.kind,
    value: input.value,
    label: input.label?.trim() || defaultLabel(input.kind, input.value),
    addedAt: Date.now(),
    ...(input.source ? { source: input.source } : {}),
  }
  write(workspaceId, [item, ...items].slice(0, MAX_ITEMS))
  return item
}

export function removeShelfItem(workspaceId: string, id: string) {
  write(workspaceId, read(workspaceId).filter(item => item.id !== id))
}

export function clearShelf(workspaceId: string) {
  write(workspaceId, [])
}

export function useShelf(workspaceId: string): ShelfItem[] {
  return useSyncExternalStore(
    listener => {
      let set = listeners.get(workspaceId)
      if (!set) { set = new Set(); listeners.set(workspaceId, set) }
      set.add(listener)
      return () => { set!.delete(listener) }
    },
    () => read(workspaceId),
  )
}

/** Test hook: forget cached lists so the next read goes to storage. */
export function __resetShelfForTest() {
  lists.clear()
  listeners.clear()
}
