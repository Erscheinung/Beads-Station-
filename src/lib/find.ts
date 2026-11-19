// Find helpers shared by the terminal find bar, the workspace-wide search and
// the conversation views. Everything here is pure so it can be unit-tested
// without xterm or React.

export interface FindOptions { caseSensitive: boolean; regex: boolean }

/** Index of the next/previous match, wrapping at both ends. -1 when there is nothing to move to. */
export function stepIndex(current: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return -1
  if (current < 0 || current >= count) return direction === 1 ? 0 : count - 1
  return (current + direction + count) % count
}

/** "3 / 17", "No results", or "" when nothing was typed. */
export function matchLabel(index: number, count: number, query: string): string {
  if (!query) return ''
  if (count <= 0) return 'No results'
  return `${index >= 0 ? index + 1 : '?'} / ${count}`
}

export type Compiled = { ok: true; pattern: RegExp } | { ok: false; error: string }

/** The query as a global RegExp. Plain text is escaped; a bad regex is reported, never thrown. */
export function compilePattern(query: string, options: FindOptions): Compiled {
  if (!query) return { ok: false, error: '' }
  try {
    const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(source, options.caseSensitive ? 'g' : 'gi')
    // An expression that matches nothing but the empty string would loop forever.
    if (new RegExp(`^(?:${source})$`, options.caseSensitive ? '' : 'i').test('')) return { ok: false, error: 'Matches the empty string' }
    return { ok: true, pattern }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.replace(/^Invalid regular expression: /, '') : 'Invalid expression' }
  }
}

/** Every match in one line as [column, length]. */
export function matchesInLine(line: string, pattern: RegExp): Array<[number, number]> {
  const found: Array<[number, number]> = []
  pattern.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(line)) !== null) {
    if (match[0].length === 0) { pattern.lastIndex++; continue }
    found.push([match.index, match[0].length])
    if (found.length >= 200) break
  }
  return found
}

// ---------- Workspace search ----------

export interface SearchSource {
  id: string
  title: string
  /** Read lazily, so a source is only walked when its turn comes. */
  lines: () => string[]
  /** A conversation or a terminal screen; the list shows it differently. */
  kind: 'terminal' | 'conversation'
}
export interface Snippet { before: string; match: string; after: string }
export interface SearchHit { sourceId: string; line: number; col: number; length: number; snippet: Snippet }
export interface SearchGroup { id: string; title: string; kind: SearchSource['kind']; hits: SearchHit[] }
export interface SearchResults { groups: SearchGroup[]; total: number; capped: boolean }

export function makeSnippet(line: string, col: number, length: number, radius = 36): Snippet {
  const start = Math.max(0, col - radius)
  const end = Math.min(line.length, col + length + radius)
  return {
    before: `${start > 0 ? '…' : ''}${line.slice(start, col).replace(/^\s+/, '')}`,
    match: line.slice(col, col + length),
    after: `${line.slice(col + length, end).replace(/\s+$/, '')}${end < line.length ? '…' : ''}`,
  }
}

const nextTask = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/**
 * Search every source for the pattern. Sources are walked one at a time with a
 * yield in between so a large scrollback never freezes the window, and the walk
 * stops at `max` hits. A `signal.cancelled` flag set by a newer query ends it early.
 */
export async function searchSources(
  sources: SearchSource[],
  pattern: RegExp,
  { max = 200, yieldFn = nextTask, signal }: { max?: number; yieldFn?: () => Promise<void>; signal?: { cancelled: boolean } } = {},
): Promise<SearchResults> {
  const groups: SearchGroup[] = []
  let total = 0
  let capped = false
  for (const source of sources) {
    if (signal?.cancelled) break
    const hits: SearchHit[] = []
    const lines = source.lines()
    for (let line = 0; line < lines.length && !capped; line++) {
      const text = lines[line]
      if (!text) continue
      for (const [col, length] of matchesInLine(text, pattern)) {
        if (total >= max) { capped = true; break }
        hits.push({ sourceId: source.id, line, col, length, snippet: makeSnippet(text, col, length) })
        total++
      }
    }
    if (hits.length) groups.push({ id: source.id, title: source.title, kind: source.kind, hits })
    if (capped) break
    await yieldFn()
  }
  return { groups, total, capped }
}

// ---------- Highlighting text (conversation views) ----------

/** The words of a query. Search treats them as "any of" for highlighting and "all of" for filtering. */
export function queryWords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))]
}

export interface Segment { text: string; match: boolean }

/** Split text into plain and matching pieces. Case-insensitive; the text is never interpreted as markup. */
export function highlightSegments(text: string, words: string[]): Segment[] {
  if (!text || words.length === 0) return [{ text, match: false }]
  const lower = text.toLowerCase()
  const ranges: Array<[number, number]> = []
  for (const word of words) {
    let from = 0
    for (let at = lower.indexOf(word, from); at >= 0; at = lower.indexOf(word, from)) {
      ranges.push([at, at + word.length])
      from = at + word.length
    }
  }
  if (ranges.length === 0) return [{ text, match: false }]
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  const merged: Array<[number, number]> = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([range[0], range[1]])
  }
  const segments: Segment[] = []
  let cursor = 0
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false })
    segments.push({ text: text.slice(start, end), match: true })
    cursor = end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false })
  return segments
}

// Minimal hast shapes: enough to wrap text nodes without a type dependency.
interface HastText { type: 'text'; value: string }
interface HastElement { type: 'element'; tagName: string; properties: Record<string, unknown>; children: HastNode[] }
type HastNode = HastText | HastElement | { type: string; children?: HastNode[] }

/**
 * A rehype plugin that wraps matching text in <mark>. It only touches text
 * nodes, so the markdown's own structure (and the sanitizer's work) is left
 * alone. A match that spans two syntax-highlight tokens is not marked.
 */
export function rehypeMark(words: string[]) {
  return () => (tree: HastNode) => {
    if (words.length === 0) return
    const visit = (node: HastNode) => {
      const children = (node as { children?: HastNode[] }).children
      if (!children) return
      const out: HastNode[] = []
      for (const child of children) {
        if (child.type === 'text') {
          const segments = highlightSegments((child as HastText).value, words)
          if (segments.length === 1 && !segments[0].match) { out.push(child); continue }
          for (const segment of segments) {
            out.push(segment.match
              ? { type: 'element', tagName: 'mark', properties: { className: ['bs-find-mark'] }, children: [{ type: 'text', value: segment.text }] }
              : { type: 'text', value: segment.text })
          }
        } else {
          visit(child)
          out.push(child)
        }
      }
      ;(node as { children?: HastNode[] }).children = out
    }
    visit(tree)
  }
}

// ---------- Colours ----------

/** A CSS colour as #RRGGBB, which is the only form xterm's decorations accept. Null when it cannot be read. */
export function toHex(value: string): string | null {
  const text = value.trim()
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase()
  const rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(text)
  if (rgb) return `#${[rgb[1], rgb[2], rgb[3]].map(part => Math.min(255, Number(part)).toString(16).padStart(2, '0')).join('')}`
  return null
}
