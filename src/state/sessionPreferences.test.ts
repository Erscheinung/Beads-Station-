import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  claudeResumeKey,
  claudeStartSession,
  clearObservedClaudeSession,
  observedProviderSession,
  rememberObservedProviderSession,
  observedClaudeSession,
  setSessionPreferences,
  useSessionPreferences,
} from './sessionPreferences'

describe('session preferences', () => {
  beforeEach(() => {
    localStorage.clear()
    act(() => setSessionPreferences({ askBeforeResume: true, restoreContextOnLaunch: true, confirmDestructiveActions: true }))
  })

  it('defaults to asking and persists preference changes', () => {
    const { result } = renderHook(() => useSessionPreferences())
    expect(result.current.askBeforeResume).toBe(true)

    act(() => setSessionPreferences({ askBeforeResume: false }))

    expect(result.current.askBeforeResume).toBe(false)
    expect(JSON.parse(localStorage.getItem('beads-station.session-preferences')!)).toEqual({ askBeforeResume: false, restoreContextOnLaunch: true, confirmDestructiveActions: true, keepTerminalsRunning: false })
  })

  it('recognizes only a non-empty provider-observed bridge session', () => {
    expect(observedClaudeSession('bridge')).toBeNull()
    expect(claudeStartSession('bridge')).toEqual({ sessionId: '', resume: false })
    localStorage.setItem(claudeResumeKey('bridge'), 'provider-session')
    expect(observedClaudeSession('bridge')).toBe('provider-session')
    expect(claudeStartSession('bridge')).toEqual({ sessionId: 'provider-session', resume: true })

    clearObservedClaudeSession('bridge')
    expect(observedClaudeSession('bridge')).toBeNull()
  })

  it('keeps provider-observed Codex identities separate and rejects blank values', () => {
    rememberObservedProviderSession('codex', 'bridge', ' thread-7 ')
    rememberObservedProviderSession('codex', 'blank', '   ')
    expect(observedProviderSession('codex', 'bridge')).toBe('thread-7')
    expect(observedProviderSession('codex', 'blank')).toBeNull()
    expect(observedClaudeSession('bridge')).toBeNull()
  })
})
