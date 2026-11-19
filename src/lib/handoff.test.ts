import { describe, expect, it, vi } from 'vitest'
import { buildHandoffMarkdown, HandoffLedger, HandoffTrigger, handoffsDue, tildePath, type HandoffInput } from './handoff'
import type { PaneUsage } from '../state/paneUsage'
// Built at runtime so no literal home path sits in the source (public-repo scan).
const USERS = ['', 'Users', ''].join('/')

const NOW = Date.parse('2026-11-20T10:00:00Z')

function usage(patch: Partial<PaneUsage> = {}): PaneUsage {
  return { provider: 'claude', sessionId: 'abc-123', contextPercent: null, contextTokens: null, contextWindow: null, tokens: null, subagents: 0, subagentTokens: null, fiveHour: null, weekly: null, limitsAt: null, updatedAt: NOW, ...patch }
}

function input(patch: Partial<HandoffInput> = {}): HandoffInput {
  return {
    now: new Date(2026, 10, 20, 9, 5), workspaceName: 'sample-project', workspacePath: `${USERS}someone/Code/sample-project`,
    provider: 'claude', sessionId: 'abc-123', usage: usage({ contextPercent: 96, fiveHour: { usedPercent: 81, windowMinutes: 300, resetsAt: 1_800_000_000 } }),
    reason: 'context',
    facts: { firstPrompt: 'Build the settings page', recentPrompts: ['Add tests\n\nwith a second paragraph', 'Use ``` fences in docs, see Code-abc'], todos: [{ text: 'Wire form', status: 'completed' }, { text: 'Add tests', status: 'in_progress' }, { text: 'Ship', status: 'pending' }], truncated: false },
    changes: [{ path: `${USERS}someone/Code/sample-project/src/a.ts`, kind: 'modified', added: 3, removed: 1 }],
    beadIds: ['Code-abc', 'Code-ab', 'Code-zzz'], resumeCommand: 'claude --resume abc-123', ...patch,
  }
}

describe('buildHandoffMarkdown', () => {
  it('keeps every prompt in full, even one that contains a code fence', () => {
    const md = buildHandoffMarkdown(input())
    expect(md).toContain('Build the settings page')
    expect(md).toContain('Add tests\n\nwith a second paragraph')
    // The prompt holds ```, so its fence is longer.
    expect(md).toContain('````\nUse ``` fences in docs, see Code-abc\n````')
  })

  it('lists the plan as checkboxes and uses ~ for home paths', () => {
    const md = buildHandoffMarkdown(input())
    expect(md).toContain('- [x] Wire form')
    expect(md).toContain('- [ ] Add tests (in progress)')
    expect(md).toContain('- [ ] Ship')
    expect(md).toContain('`~/Code/sample-project`')
    expect(md).toContain('`~/Code/sample-project/src/a.ts` modified (+3 -1)')
    expect(md).not.toContain(`${USERS}`)
  })

  it('names only tickets the prompts mention, and the exact resume command', () => {
    const md = buildHandoffMarkdown(input())
    expect(md).toContain('- Ticket: `Code-abc`')
    expect(md).not.toContain('Code-zzz')
    expect(md).toContain('claude --resume abc-123')
  })

  it('shows unknown usage and unreadable parts as unknown, never as zero', () => {
    const md = buildHandoffMarkdown(input({ usage: usage(), facts: null, changes: null, resumeCommand: null, reason: 'manual', sessionId: null }))
    expect(md).toContain('- Context: unknown')
    expect(md).toContain('- 5-hour limit: unknown')
    expect(md).toContain('- Weekly limit: unknown')
    expect(md).toContain('session `unknown`')
    expect(md).toContain('_Unknown: the session file could not be read._')
    expect(md).toContain('_Unknown: the workspace could not be read._')
    expect(md).toContain('No resume command is known')
    expect(md).not.toMatch(/Context: 0%/)
  })

  it('reports the usage it was given', () => {
    const md = buildHandoffMarkdown(input())
    expect(md).toContain('- Context: 96%')
    expect(md).toContain('- 5-hour limit: 81%, resets')
  })
})

describe('tildePath', () => {
  it('abbreviates only a leading home folder', () => {
    expect(tildePath(`${USERS}a/b`)).toBe('~/b')
    expect(tildePath('/home/a')).toBe('~')
    expect(tildePath(`/opt${USERS}a`)).toBe(`/opt${USERS}a`)
  })
})

describe('handoffsDue', () => {
  const reset = Math.floor(NOW / 1000) + 3600
  const window = (usedPercent: number) => ({ usedPercent, windowMinutes: 300, resetsAt: reset })

  it('does nothing below the threshold, when off, or when unknown', () => {
    expect(handoffsDue(usage({ contextPercent: 94, fiveHour: window(94), limitsAt: NOW }), 95, NOW)).toEqual([])
    expect(handoffsDue(usage({ contextPercent: 99 }), 0, NOW)).toEqual([])
    expect(handoffsDue(usage(), 95, NOW)).toEqual([])
    expect(handoffsDue(usage({ contextPercent: 99, sessionId: null }), 95, NOW)).toEqual([])
    expect(handoffsDue(usage({ provider: 'gemini', contextPercent: 99 }), 95, NOW)).toEqual([])
  })

  it('fires on context or on the 5-hour window, keyed by session and reset', () => {
    expect(handoffsDue(usage({ contextPercent: 95 }), 95, NOW)).toEqual([{ reason: 'context', key: 'claude:abc-123:ctx' }])
    expect(handoffsDue(usage({ fiveHour: window(97), limitsAt: NOW }), 95, NOW)).toEqual([{ reason: 'five-hour', key: `claude:abc-123:5h:${reset}` }])
  })

  it('ignores an old limit reading or a window that already reset', () => {
    expect(handoffsDue(usage({ fiveHour: window(99), limitsAt: NOW - 3_600_000 }), 95, NOW)).toEqual([])
    expect(handoffsDue(usage({ fiveHour: { usedPercent: 99, windowMinutes: 300, resetsAt: Math.floor(NOW / 1000) - 10 }, limitsAt: NOW }), 95, NOW)).toEqual([])
  })
})

describe('HandoffTrigger', () => {
  function memory() {
    const data = new Map<string, string>()
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } }
  }

  it('saves once per session and window, across updates and a restart', async () => {
    const storage = memory()
    const save = vi.fn().mockResolvedValue(true)
    const make = () => new HandoffTrigger({ threshold: () => 95, ledger: new HandoffLedger(storage), save, now: () => NOW })
    const trigger = make()
    const reset = Math.floor(NOW / 1000) + 3600
    const hot = usage({ contextPercent: 97, fiveHour: { usedPercent: 96, windowMinutes: 300, resetsAt: reset }, limitsAt: NOW })
    trigger.check('p1', usage({ contextPercent: 40 }))
    expect(save).not.toHaveBeenCalled()
    trigger.check('p1', hot)
    trigger.check('p1', hot)
    await Promise.resolve()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('p1', 'context')
    // A restart reads the remembered keys: nothing is written again.
    make().check('p1', hot)
    expect(save).toHaveBeenCalledTimes(1)
    // A new 5-hour window of the same session is a new reason.
    trigger.check('p1', usage({ contextPercent: 10, fiveHour: { usedPercent: 99, windowMinutes: 300, resetsAt: reset + 18_000 }, limitsAt: NOW }))
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith('p1', 'five-hour')
  })

  it('tries again after a failed write', async () => {
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    const trigger = new HandoffTrigger({ threshold: () => 95, ledger: new HandoffLedger(null), save, now: () => NOW })
    const hot = usage({ contextPercent: 99 })
    trigger.check('p', hot)
    await new Promise(resolve => setTimeout(resolve, 0))
    trigger.check('p', hot)
    expect(save).toHaveBeenCalledTimes(2)
  })
})
