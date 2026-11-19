import { beforeEach, describe, expect, it, vi } from 'vitest'
import { classifySoundEvent, requestSound, previewSound, __resetSoundsForTest } from './sounds'
import { DEFAULT_SOUNDS, setNotificationPreferences } from '../state/notificationPreferences'

let started = 0
class FakeAudioContext {
  state = 'running'
  currentTime = 0
  destination = {}
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} } }
  createOscillator() { return { type: '', frequency: { value: 0 }, connect() {}, start() { started++ }, stop() {} } }
}

beforeEach(() => {
  started = 0
  vi.stubGlobal('window', { AudioContext: FakeAudioContext })
  __resetSoundsForTest()
  setNotificationPreferences({ sounds: DEFAULT_SOUNDS })
})

describe('classifySoundEvent', () => {
  it('maps sources and wording to events', () => {
    expect(classifySoundEvent('bell', '')).toBe('waiting')
    expect(classifySoundEvent('quiet', '')).toBe('responded')
    expect(classifySoundEvent('agent', '')).toBe('responded')
    expect(classifySoundEvent('osc', 'Claude Code: Subagent finished')).toBe('subagent')
    expect(classifySoundEvent('osc', 'Claude Code: Claude needs your permission to use Bash')).toBe('waiting')
    expect(classifySoundEvent('osc', 'Claude Code: Finished, waiting for you')).toBe('responded')
    expect(classifySoundEvent('osc', 'Agent turn complete')).toBe('responded')
  })
})

describe('requestSound', () => {
  it('plays an enabled event and stays silent for a disabled one', () => {
    expect(requestSound('p1', 'waiting', false, 0)).toBe(true)
    expect(started).toBeGreaterThan(0)
    expect(requestSound('p2', 'subagent', false, 10_000)).toBe(false)
  })
  it('debounces per pane (1.5 s) and globally (400 ms)', () => {
    expect(requestSound('p1', 'waiting', false, 0)).toBe(true)
    expect(requestSound('p2', 'waiting', false, 100)).toBe(false)
    expect(requestSound('p2', 'waiting', false, 500)).toBe(true)
    expect(requestSound('p1', 'waiting', false, 1000)).toBe(false)
    expect(requestSound('p1', 'waiting', false, 1600)).toBe(true)
  })
  it('skips an attended pane only when the focus rule is on', () => {
    expect(requestSound('p1', 'waiting', true, 0)).toBe(false)
    setNotificationPreferences({ sounds: { ...DEFAULT_SOUNDS, onlyWhenAway: false } })
    expect(requestSound('p1', 'waiting', true, 5000)).toBe(true)
  })
  it('preview plays regardless of the enabled switch', () => {
    previewSound('subagent')
    expect(started).toBeGreaterThan(0)
  })
})
