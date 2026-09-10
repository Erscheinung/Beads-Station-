import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  claudeResumeKey,
  claudeStartSession,
  clearObservedClaudeSession,
  observedClaudeSession,
  setSessionPreferences,
  useSessionPreferences,
} from './sessionPreferences'

describe('session preferences', () => {
  beforeEach(() => {
    localStorage.clear()
    act(() => setSessionPreferences({ askBeforeResume: true }))
  })

  it('defaults to asking and persists preference changes', () => {
    const { result } = renderHook(() => useSessionPreferences())
    expect(result.current.askBeforeResume).toBe(true)

    act(() => setSessionPreferences({ askBeforeResume: false }))

    expect(result.current.askBeforeResume).toBe(false)
    expect(JSON.parse(localStorage.getItem('beads-station.session-preferences')!)).toEqual({ askBeforeResume: false })
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
})
