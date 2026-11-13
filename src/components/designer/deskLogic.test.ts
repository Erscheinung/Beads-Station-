import { beforeEach, describe, expect, it } from 'vitest'
import { addShelfItem, classifyInput, composePayload, defaultLabel, quotePath, removeShelfItem, __resetShelfForTest, type ShelfItem } from './shelf'
import { agentResumeCommand } from '../../state/agentHooks'
import { filterTurns, formatTokens, relativeTime, turnProse, usageLine, type TranscriptTurn } from './transcripts'

const turn = (role: 'user' | 'assistant', text: string, extra: Partial<TranscriptTurn> = {}): TranscriptTurn =>
  ({ role, at: null, blocks: [{ kind: 'text', text }], files: [], thinking: 0, ...extra })

describe('classifyInput', () => {
  it('tells paths from text without a mode switch', () => {
    expect(classifyInput('  ')).toBeNull()
    expect(classifyInput('~/Documents/nAI/Plan.md')).toEqual({ kind: 'markdown', value: '~/Documents/nAI/Plan.md' })
    expect(classifyInput('/home/me/app/src/main.rs')).toEqual({ kind: 'file', value: '/home/me/app/src/main.rs' })
    expect(classifyInput('/home/me/My\\ Vault/a.md')).toEqual({ kind: 'markdown', value: '/home/me/My Vault/a.md' })
    expect(classifyInput('/home/me/My Vault/a.md')).toEqual({ kind: 'markdown', value: '/home/me/My Vault/a.md' })
    expect(classifyInput("'/home/me/a b/shot.png'")).toEqual({ kind: 'file', value: '/home/me/a b/shot.png' })
  })

  it('keeps slash commands, sentences and multi-line text as notes', () => {
    expect(classifyInput('/review this please')?.kind).toBe('note')
    expect(classifyInput('/compact')?.kind).toBe('note')
    expect(classifyInput('/usr/bin is where it lives')?.kind).toBe('note')
    expect(classifyInput('see ~/notes.md for context')?.kind).toBe('note')
    expect(classifyInput('/home/me/a.md\nand more')?.kind).toBe('note')
  })
})

describe('shelf payload', () => {
  const item = (kind: ShelfItem['kind'], value: string, label = 'L'): ShelfItem => ({ id: value, kind, value, label, addedAt: 0 })

  it('quotes awkward paths for the shell and @-mentions', () => {
    expect(quotePath('/a/b.md')).toBe('/a/b.md')
    expect(quotePath("/a/it's here.md")).toBe(`'/a/it'\\''s here.md'`)
    expect(defaultLabel('file', '/a/b/c.md')).toBe('c.md')
    expect(defaultLabel('note', '\n\nfirst line\nsecond')).toBe('first line')
  })

  it('sends files as paths, notes and small markdown as headed text, big markdown as a path', async () => {
    const reads: Record<string, { content: string; truncated: boolean; binary: boolean }> = {
      '/n/small.md': { content: ' small body \n', truncated: false, binary: false },
      '/n/big.md': { content: 'x', truncated: true, binary: false },
    }
    const text = await composePayload(
      [item('file', '/p/a b.png'), item('note', 'remember X', 'Idea'), item('markdown', '/n/small.md', 'Small'), item('markdown', '/n/big.md'), item('markdown', '/n/missing.md')],
      async path => { if (!(path in reads)) throw new Error('gone'); return reads[path] },
    )
    expect(text).toBe(["'/p/a b.png'", '## Idea\nremember X', '## Small\nsmall body', '/n/big.md', '/n/missing.md'].join('\n\n'))
  })
})

describe('shelf store', () => {
  beforeEach(() => { localStorage.clear(); __resetShelfForTest() })

  it('keeps items per workspace, de-duplicates, and survives a reload', () => {
    const first = addShelfItem('w1', { kind: 'note', value: 'hello' })
    expect(addShelfItem('w1', { kind: 'note', value: 'hello' }).id).toBe(first.id)
    addShelfItem('w2', { kind: 'file', value: '/x/y.ts' })
    __resetShelfForTest()
    expect(JSON.parse(localStorage.getItem('bs.shelf.w1')!)).toHaveLength(1)
    removeShelfItem('w1', first.id)
    expect(JSON.parse(localStorage.getItem('bs.shelf.w1')!)).toHaveLength(0)
    expect(JSON.parse(localStorage.getItem('bs.shelf.w2')!)).toHaveLength(1)
  })

  it('ignores corrupt stored data', () => {
    localStorage.setItem('bs.shelf.w3', '{"nope":1}')
    expect(addShelfItem('w3', { kind: 'note', value: 'ok' }).label).toBe('ok')
  })
})

describe('transcript helpers', () => {
  it('searches every word across prose, tools and edited files', () => {
    const turns = [
      turn('user', 'Fix the header'),
      turn('assistant', 'Done', { blocks: [{ kind: 'text', text: 'Done' }, { kind: 'tool', name: 'Edit', summary: 'src/Header.tsx', result: null }], files: ['src/Header.tsx'] }),
      turn('user', 'Unrelated'),
    ]
    expect(filterTurns(turns, '')).toHaveLength(3)
    expect(filterTurns(turns, 'HEADER')).toHaveLength(2)
    expect(filterTurns(turns, 'edit header')).toHaveLength(1)
    expect(filterTurns(turns, 'nothing')).toHaveLength(0)
  })

  it('pins prose only, never tool plumbing', () => {
    const mixed = turn('assistant', 'A', { blocks: [{ kind: 'text', text: 'A' }, { kind: 'tool', name: 'Bash', summary: 'ls', result: 'x' }, { kind: 'text', text: 'B' }] })
    expect(turnProse(mixed)).toBe('A\n\nB')
  })

  it('formats tokens and time without claiming cost', () => {
    expect([formatTokens(950), formatTokens(1200), formatTokens(12_400), formatTokens(2_300_000)]).toEqual(['950', '1.2k', '12k', '2.3M'])
    expect(usageLine(null)).toBe('Usage not recorded for this session')
    expect(usageLine({ input: 100, output: 2000, cacheRead: 5_000_000, cacheCreate: 900 })).toBe('1.0k new in · 2.0k out · 5.0M cached')
    const now = 10_000_000_000
    expect([relativeTime(now - 5_000, now), relativeTime(now - 5 * 60_000, now), relativeTime(now - 3 * 3_600_000, now), relativeTime(now - 2 * 86_400_000, now)]).toEqual(['just now', '5m ago', '3h ago', '2d ago'])
  })
})

describe('resume', () => {
  it('resumes the exact session that was read, never "the last one"', () => {
    const id = 'aaaa1111-0000-4000-8000-000000000001'
    expect(agentResumeCommand('claude', id)).toContain(`--resume ${id}`)
    expect(agentResumeCommand('codex', id)).toContain(`codex resume ${id}`)
  })
})

import { pace, windowLabel } from './transcripts'
describe('meter pace', () => {
  const win = { usedPercent: 60, windowMinutes: 300, resetsAt: 1_000_000 + 150 * 60 } // halfway through a 5 h window
  it('compares use with an even burn', () => {
    expect(pace(win, 1_000_000)).toMatchObject({ status: 'ahead', elapsed: 50, resetsIn: 'resets in 2h 30m' })
    expect(pace({ ...win, usedPercent: 50 }, 1_000_000).status).toBe('on-pace')
    expect(pace({ ...win, usedPercent: 20 }, 1_000_000).status).toBe('under')
  })
  it('does not trust a reading whose window has already reset', () => {
    expect(pace(win, 2_000_000)).toMatchObject({ status: 'reset', used: 0 })
  })
  it('names windows', () => {
    expect([windowLabel(300), windowLabel(10080), windowLabel(2880)]).toEqual(['5-hour', 'Weekly', '2-day'])
  })
})

import { mentionsBead, requestHistoryFocus, takeHistoryFocus } from './transcripts'
describe('bead to session links', () => {
  const prompt = 'Work on ticket Code-05b.1: Transcripts. Read it with "bd show Code-05b.1" first.'
  it('matches the ticket id as a whole token only', () => {
    expect(mentionsBead({ firstPrompt: prompt }, 'Code-05b.1')).toBe(true)
    expect(mentionsBead({ firstPrompt: prompt }, 'Code-05b')).toBe(false)
    expect(mentionsBead({ firstPrompt: prompt }, 'Code-05')).toBe(false)
    expect(mentionsBead({ firstPrompt: 'unrelated' }, 'Code-05b.1')).toBe(false)
    expect(mentionsBead({ firstPrompt: prompt }, '')).toBe(false)
  })
  it('hands a focus request over exactly once', () => {
    requestHistoryFocus('w', { provider: 'codex', id: 'x' })
    expect(takeHistoryFocus('w')).toBe('codex:x')
    expect(takeHistoryFocus('w')).toBeNull()
  })
})

import { groupBlocks } from './ConversationView'
describe('groupBlocks', () => {
  it('folds consecutive tool calls into one group and keeps prose apart', () => {
    const tool = (name: string) => ({ kind: 'tool' as const, name, summary: 'x', result: null })
    const groups = groupBlocks([{ kind: 'text', text: 'a' }, tool('exec'), tool('exec'), { kind: 'text', text: 'b' }, tool('Edit')])
    expect(groups.map(group => group.kind)).toEqual(['text', 'tools', 'text', 'tools'])
    expect(groups[1].kind === 'tools' && groups[1].tools.length).toBe(2)
  })
})
