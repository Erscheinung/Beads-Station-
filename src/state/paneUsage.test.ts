import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }))
import {
  __resetPaneUsageForTest, applyFileUsage, applyStatuslineUsage, getPaneUsage, limitsText, notePaneAgent,
  parseUsageReport, refreshPaneUsage, subscribePaneUsage, usageChipText, usageTooltip, type PaneUsage,
} from './paneUsage'

const ID = '2c975569-13c1-43b2-8e7a-f88d6138d7d8'
const NOW = 1_763_640_000 // unix seconds

function usage(partial: Partial<PaneUsage>): PaneUsage {
  return { provider: 'claude', sessionId: ID, contextPercent: null, contextTokens: null, contextWindow: null, tokens: null, subagents: 0, subagentTokens: null, fiveHour: null, weekly: null, limitsAt: null, updatedAt: 0, ...partial }
}

beforeEach(() => { __resetPaneUsageForTest(); mock.invoke.mockReset(); mock.invoke.mockResolvedValue(null) })
afterEach(() => { __resetPaneUsageForTest() })

describe('OSC 7770 usage reports', () => {
  it('reads the wrapper\'s flat payload', () => {
    const report = parseUsageReport(`usage;claude;{"session_id":"${ID}","context_window_size":200000,"five_hour":{"used_percentage":81.5,"resets_at":1763650800},"seven_day":{"used_percentage":69,"resets_at":1764000000},"used_percentage":42}`)
    expect(report).toEqual({
      sessionId: ID, contextPercent: 42, contextWindow: 200000,
      fiveHour: { usedPercent: 81.5, windowMinutes: 300, resetsAt: 1763650800 },
      weekly: { usedPercent: 69, windowMinutes: 10080, resetsAt: 1764000000 },
    })
  })

  it('reads Claude\'s own nested shape, base64, ISO and millisecond reset times', () => {
    const json = JSON.stringify({ session_id: ID, cwd: '~/Projekte/café', context_window: { used_percentage: 7, context_window_size: 1_000_000 }, rate_limits: { five_hour: { used_percentage: 12, resets_at: '2025-11-20T14:20:00Z' }, seven_day: { used_percentage: 3, resets_at: 1764000000000 } } })
    const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)))
    const report = parseUsageReport(`usage;claude;${base64}`)!
    expect(report.contextPercent).toBe(7)
    expect(report.contextWindow).toBe(1_000_000)
    expect(report.fiveHour?.resetsAt).toBe(Math.round(Date.parse('2025-11-20T14:20:00Z') / 1000))
    expect(report.weekly?.resetsAt).toBe(1764000000)
  })

  it('keeps unknown fields unknown and rejects anything that is not a report', () => {
    expect(parseUsageReport(`usage;claude;{"session_id":"${ID}"}`)).toEqual({ sessionId: ID, contextPercent: null, contextWindow: null, fiveHour: null, weekly: null })
    expect(parseUsageReport('usage;claude;{"session_id":"../../x","used_percentage":"lots","five_hour":{"used_percentage":5}}')).toEqual({ sessionId: null, contextPercent: null, contextWindow: null, fiveHour: null, weekly: null })
    expect(parseUsageReport('usage;claude;{"five_hour":null,"seven_day":"x","used_percentage":140}')?.contextPercent).toBe(100)
    expect(parseUsageReport('usage;codex;{}')).toBeNull()
    expect(parseUsageReport('session;claude;' + ID)).toBeNull()
    expect(parseUsageReport('usage;claude;')).toBeNull()
    expect(parseUsageReport('usage;claude;[1,2]')).toBeNull()
    expect(parseUsageReport('usage;claude;%%%')).toBeNull()
  })
})

describe('the pane usage store', () => {
  it('merges the status line and the session file, and starts over for a new session', async () => {
    const seen = vi.fn()
    const stop = subscribePaneUsage(seen)
    applyStatuslineUsage('p', { sessionId: ID, contextPercent: 42, contextWindow: 200000, fiveHour: { usedPercent: 80, windowMinutes: 300, resetsAt: NOW + 3600 }, weekly: null })
    applyFileUsage('p', { provider: 'claude', sessionId: ID, usage: { input: 10, output: 20, cacheRead: 30, cacheCreate: 0 }, subagents: 2, subagentUsage: { input: 1, output: 2, cacheRead: 3, cacheCreate: 0 }, contextTokens: 84000, contextWindow: null, limits: null })
    expect(getPaneUsage('p')).toMatchObject({ contextPercent: 42, contextTokens: 84000, contextWindow: 200000, subagents: 2, tokens: { output: 20 } })
    expect(seen).toHaveBeenCalled()
    // /clear: a new id. Totals belong to the old session; account limits do not.
    notePaneAgent('p', 'claude', '0123abcd-0123-4abc-8def-0123456789ab')
    expect(getPaneUsage('p')).toMatchObject({ contextPercent: null, tokens: null, subagents: 0, fiveHour: { usedPercent: 80 } })
    // A file reading for the old session is not applied to the new one.
    applyFileUsage('p', { provider: 'claude', sessionId: ID, usage: { input: 1, output: 1, cacheRead: 1, cacheCreate: 1 }, subagents: 0, subagentUsage: null, contextTokens: 5, contextWindow: null, limits: null })
    expect(getPaneUsage('p')?.tokens).toBeNull()
    notePaneAgent('p', null)
    expect(getPaneUsage('p')).toBeNull()
    stop()
  })

  it('reads the session file by provider and id only, and not more often than needed', async () => {
    notePaneAgent('p', 'codex', null)
    refreshPaneUsage('p')
    expect(mock.invoke).not.toHaveBeenCalled()
    notePaneAgent('p', 'codex', ID)
    mock.invoke.mockResolvedValue({ provider: 'codex', sessionId: ID, usage: null, subagents: 0, subagentUsage: null, contextTokens: 96000, contextWindow: 475000, limits: { primary: { usedPercent: 81, windowMinutes: 300, resetsAt: NOW + 60 }, secondary: null, observedAt: '2026-11-20T09:00:00Z' } })
    refreshPaneUsage('p', '/repo')
    expect(mock.invoke).toHaveBeenCalledWith('session_usage', { provider: 'codex', sessionId: ID, cwd: '/repo' })
    await vi.waitFor(() => expect(getPaneUsage('p')?.contextTokens).toBe(96000))
    expect(getPaneUsage('p')?.limitsAt).toBe(Date.parse('2026-11-20T09:00:00Z'))
    refreshPaneUsage('p', '/repo')
    expect(mock.invoke).toHaveBeenCalledTimes(1)
    refreshPaneUsage('p', '/repo', true)
    expect(mock.invoke).toHaveBeenCalledTimes(2)
  })
})

describe('chip text', () => {
  it('shows context use, its size and subagents', () => {
    expect(usageChipText(usage({ contextPercent: 42, contextTokens: 180_000, subagents: 2 }))).toBe('Claude · ctx 42% · 180k (+2 subagents)')
    expect(usageChipText(usage({ contextPercent: 7 }))).toBe('Claude · ctx 7%')
    expect(usageChipText(usage({ provider: 'codex', contextTokens: 96_000, contextWindow: 475_000 }))).toBe('Codex · ctx 20% · 96k')
    expect(usageChipText(usage({ provider: 'gemini', contextTokens: 2410, subagents: 1 }))).toBe('Gemini · 2.4k (+1 subagent)')
    expect(usageChipText(usage({ tokens: { input: 1200, output: 3400, cacheRead: 9_000_000, cacheCreate: 300 } }))).toBe('Claude · 1.5k in · 3.4k out')
  })

  it('is hidden when nothing is known, and never shows 0 for unknown', () => {
    expect(usageChipText(null)).toBeNull()
    expect(usageChipText(usage({}))).toBeNull()
    expect(usageChipText(usage({ subagents: 3 }))).toBeNull()
    const tip = usageTooltip(usage({ contextPercent: 42 }), NOW)
    expect(tip).toContain('Context: (42%)')
    expect(tip).not.toMatch(/\b0 /)
  })

  it('lists tokens and limits in the tooltip', () => {
    const tip = usageTooltip(usage({
      contextTokens: 84_000, contextWindow: 200_000, tokens: { input: 10, output: 2000, cacheRead: 1_500_000, cacheCreate: 800 },
      subagents: 1, subagentTokens: { input: 5, output: 70, cacheRead: 0, cacheCreate: 0 },
      fiveHour: { usedPercent: 81, windowMinutes: 300, resetsAt: NOW + 3600 }, limitsAt: NOW * 1000,
    }), NOW)
    expect(tip).toContain('Context: 84k tokens of 200k (42%)')
    expect(tip).toContain('This session: 810 in · 1.5M cached · 2.0k out')
    expect(tip).toContain('1 subagent: 5 in · 0 cached · 70 out')
    expect(tip).toMatch(/Limits: 5h 81% · resets \d\d:\d\d/)
  })
})

describe('status bar limits', () => {
  it('shows both windows and the sooner reset', () => {
    const text = limitsText(usage({ fiveHour: { usedPercent: 81.4, windowMinutes: 300, resetsAt: NOW + 3600 }, weekly: { usedPercent: 69, windowMinutes: 10080, resetsAt: NOW + 86400 }, limitsAt: NOW * 1000 }), NOW)
    const at = new Date((NOW + 3600) * 1000)
    expect(text).toEqual({ text: `5h 81% · wk 69% · resets ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`, stale: false })
  })

  it('marks a passed reset and an old reading as stale, and shows nothing when unknown', () => {
    expect(limitsText(usage({ fiveHour: { usedPercent: 90, windowMinutes: 300, resetsAt: NOW - 10 }, weekly: { usedPercent: 50, windowMinutes: 10080, resetsAt: NOW + 999 } }), NOW)?.text).toMatch(/^5h reset · wk 50% · resets/)
    expect(limitsText(usage({ fiveHour: { usedPercent: 90, windowMinutes: 300, resetsAt: NOW - 10 } }), NOW)).toEqual({ text: '5h reset', stale: true })
    expect(limitsText(usage({ weekly: { usedPercent: 50, windowMinutes: 10080, resetsAt: NOW + 999 }, limitsAt: (NOW - 3600) * 1000 }), NOW)?.stale).toBe(true)
    expect(limitsText(usage({}), NOW)).toBeNull()
    expect(limitsText(null, NOW)).toBeNull()
  })
})
