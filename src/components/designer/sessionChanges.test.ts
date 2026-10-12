import { describe, expect, it } from 'vitest'
import { diffSections, fileChanges, ticketPrompt } from './sessionChanges'

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1..2 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,2 +1,3 @@',
  ' keep',
  '-old',
  '+new',
  '+more',
  'diff --git a/gone.txt b/gone.txt',
  'deleted file mode 100644',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
].join('\n')

const file = (path: string, status: string, content: string | null = null) =>
  ({ path, status, size: 1, contentHash: 'h', content, binary: false, truncated: false })

describe('session changes', () => {
  it('gives each file its own diff section', () => {
    const sections = diffSections(DIFF)
    expect([...sections.keys()]).toEqual(['src/app.ts', 'gone.txt'])
    expect(sections.get('src/app.ts')).toContain('+more')
    expect(sections.get('src/app.ts')).not.toContain('gone.txt')
  })
  it('counts added and removed lines and classifies new, edited and gone files', () => {
    const changes = fileChanges({ diff: DIFF, files: [file('src/app.ts', 'M'), file('gone.txt', 'D'), file('notes.md', '??', 'one\ntwo\n')] })
    expect(changes.map(change => [change.path, change.kind, change.added, change.removed])).toEqual([
      ['src/app.ts', 'edited', 2, 1],
      ['gone.txt', 'gone', 0, 1],
      ['notes.md', 'new', 2, 0],
    ])
    expect(changes[2].content).toBe('one\ntwo\n')
    expect(changes[0].content).toBeNull()
  })
  it('writes a single-line ticket prompt that keeps the ticket open', () => {
    const prompt = ticketPrompt({ id: 'Code-1', title: 'Fix\n the   header' })
    expect(prompt).not.toContain('\n')
    expect(prompt).toContain('Code-1: Fix the header.')
    expect(prompt).toContain('do not close the ticket')
  })
})
