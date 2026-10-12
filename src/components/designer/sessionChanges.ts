// The "ink spill" of a live Designer session: which files the workspace has
// changed, how much, and each file's own slice of the diff.

import type { ArtifactRevision } from './artifacts'

export interface FileChange {
  path: string
  /** new | edited | gone */
  kind: 'new' | 'edited' | 'gone'
  added: number
  removed: number
  /** This file's section of the unified diff, when git produced one. */
  diff: string | null
  /** Full text of a file git does not track yet. */
  content: string | null
}

function kindOf(status: string): FileChange['kind'] {
  if (status.includes('D')) return 'gone'
  if (status.includes('?') || status.includes('A')) return 'new'
  return 'edited'
}

/** Split a unified diff into one section per file, keyed by the new path. */
export function diffSections(diff: string): Map<string, string> {
  const sections = new Map<string, string>()
  const starts = [...diff.matchAll(/^diff --git a\/.+? b\/(.+)$/gm)]
  starts.forEach((match, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].index : diff.length
    sections.set(match[1], diff.slice(match.index, end).trimEnd())
  })
  return sections
}

function countLines(section: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of section.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    else if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return { added, removed }
}

export function fileChanges(revision: Pick<ArtifactRevision, 'files' | 'diff'>): FileChange[] {
  const sections = diffSections(revision.diff ?? '')
  return revision.files.map(file => {
    const diff = sections.get(file.path) ?? null
    const kind = kindOf(file.status)
    const content = diff === null && !file.binary ? file.content ?? null : null
    const counts = diff !== null
      ? countLines(diff)
      : { added: content ? content.split('\n').length - (content.endsWith('\n') ? 1 : 0) : 0, removed: 0 }
    return { path: file.path, kind, ...counts, diff, content }
  })
}

/** One line that starts an agent CLI on a ticket; short so the shell never wraps a quoted block. */
export function ticketPrompt(issue: { id: string; title: string }): string {
  const title = issue.title.replace(/\s+/g, ' ').trim()
  return `Work on ticket ${issue.id}: ${title}. Read it with "bd show ${issue.id}" first. Keep the work scoped to this ticket, run the relevant checks, and do not close the ticket: I review the result in Beads Station.`
}
