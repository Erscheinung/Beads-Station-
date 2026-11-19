// Short synthesized alert sounds (Web Audio, no assets) and the rules for when
// one may play. Nothing here starts a process; it only reacts to a pane that
// the notification layer has already decided needs the user.

import { getNotificationPreferences, type SoundEvent, type SoundName } from '../state/notificationPreferences'

export const PANE_DEBOUNCE_MS = 1500
export const GLOBAL_DEBOUNCE_MS = 400

interface Note { freq: number; at: number; length: number; type?: OscillatorType; gain?: number }

const SOUNDS: Record<SoundName, Note[]> = {
  chime: [{ freq: 880, at: 0, length: 0.18 }, { freq: 1318.5, at: 0.12, length: 0.32 }],
  pop: [{ freq: 520, at: 0, length: 0.09, type: 'triangle' }, { freq: 340, at: 0.05, length: 0.1, type: 'triangle' }],
  tick: [{ freq: 1800, at: 0, length: 0.04, type: 'square', gain: 0.35 }],
  bell: [{ freq: 1046.5, at: 0, length: 0.7, gain: 0.8 }, { freq: 2093, at: 0, length: 0.4, gain: 0.25 }],
}

let context: AudioContext | null = null

function audio(): AudioContext | null {
  if (context) return context
  const Ctor = typeof window === 'undefined' ? undefined : (window.AudioContext ?? (window as any).webkitAudioContext)
  if (!Ctor) return null
  try { context = new Ctor() } catch { return null }
  return context
}

/** Play one named sound at a volume from 0 to 1. Never throws. */
export function playSound(name: SoundName, volume: number): void {
  try {
    const ctx = audio()
    if (!ctx || volume <= 0) return
    if (ctx.state === 'suspended') void ctx.resume?.()
    const start = ctx.currentTime
    for (const note of SOUNDS[name]) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = note.type ?? 'sine'
      osc.frequency.value = note.freq
      const peak = Math.max(0.0001, Math.min(1, volume) * 0.4 * (note.gain ?? 1))
      const from = start + note.at
      gain.gain.setValueAtTime(0.0001, from)
      gain.gain.exponentialRampToValueAtTime(peak, from + 0.008)
      gain.gain.exponentialRampToValueAtTime(0.0001, from + note.length)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(from)
      osc.stop(from + note.length + 0.02)
    }
  } catch { /* sound is optional */ }
}

/** The preview button: plays the event's chosen sound, ignoring the enabled switch and debounce. */
export function previewSound(event: SoundEvent): void {
  const { sounds } = getNotificationPreferences()
  playSound(sounds[event].sound, sounds.volume)
}

/** Which kind of alert a notification is, from where it came from and what it said. */
export function classifySoundEvent(source: 'bell' | 'osc' | 'quiet' | 'agent', message: string): SoundEvent {
  if (source === 'quiet' || source === 'agent') return 'responded'
  if (source === 'bell') return 'waiting'
  if (/subagent/i.test(message)) return 'subagent'
  // Needs-you wording first: "Finished, waiting for you" is a finished turn,
  // "needs your permission" and "waiting for your input" are questions.
  if (/permission|approv|needs|input|attention|question|confirm/i.test(message)) return 'waiting'
  if (/finish|complete|done|ready|responded/i.test(message)) return 'responded'
  return 'waiting'
}

let lastGlobal = -Infinity
const lastByPane = new Map<string, number>()

/**
 * Ask for the sound of an event on a pane. `attended` is true when the user is
 * looking at that pane in a focused window. Returns whether a sound played.
 */
export function requestSound(paneId: string, event: SoundEvent, attended: boolean, now = performance.now()): boolean {
  const { sounds } = getNotificationPreferences()
  if (!sounds[event].enabled) return false
  if (sounds.onlyWhenAway && attended) return false
  if (now - lastGlobal < GLOBAL_DEBOUNCE_MS) return false
  if (now - (lastByPane.get(paneId) ?? -Infinity) < PANE_DEBOUNCE_MS) return false
  lastGlobal = now
  lastByPane.set(paneId, now)
  playSound(sounds[event].sound, sounds.volume)
  return true
}

export function __resetSoundsForTest(): void {
  lastGlobal = -Infinity
  lastByPane.clear()
  context = null
}
