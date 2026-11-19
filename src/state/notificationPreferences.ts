import { useSyncExternalStore } from 'react'
import { persistDurableUserConfigKey } from '../lib/durableUserConfig'

export type SoundEvent = 'waiting' | 'responded' | 'subagent'
export type SoundName = 'chime' | 'pop' | 'tick' | 'bell'
export const SOUND_EVENTS: readonly SoundEvent[] = ['waiting', 'responded', 'subagent']
export const SOUND_NAMES: readonly SoundName[] = ['chime', 'pop', 'tick', 'bell']

export interface SoundPreferences {
  waiting: { enabled: boolean; sound: SoundName }
  responded: { enabled: boolean; sound: SoundName }
  subagent: { enabled: boolean; sound: SoundName }
  /** 0 to 1. */
  volume: number
  /** Stay silent when the window is focused and the pane is the one on screen. */
  onlyWhenAway: boolean
}

export const DEFAULT_SOUNDS: SoundPreferences = {
  waiting: { enabled: true, sound: 'chime' },
  responded: { enabled: true, sound: 'pop' },
  subagent: { enabled: false, sound: 'tick' },
  volume: 0.6,
  onlyWhenAway: true,
}

function loadSounds(value: unknown): SoundPreferences {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, any>
  const event = (name: SoundEvent) => {
    const item = raw[name] ?? {}
    const fallback = DEFAULT_SOUNDS[name]
    return {
      enabled: typeof item.enabled === 'boolean' ? item.enabled : fallback.enabled,
      sound: SOUND_NAMES.includes(item.sound) ? (item.sound as SoundName) : fallback.sound,
    }
  }
  const volume = typeof raw.volume === 'number' && Number.isFinite(raw.volume) ? Math.min(1, Math.max(0, raw.volume)) : DEFAULT_SOUNDS.volume
  return { waiting: event('waiting'), responded: event('responded'), subagent: event('subagent'), volume, onlyWhenAway: raw.onlyWhenAway !== false }
}

export interface NotificationPreferences {
  /** Short sounds when an agent waits, responds or finishes a subagent. */
  sounds: SoundPreferences
  /** Mark panes that need attention (ring, tab dots). */
  enabled: boolean
  /** Also treat a background terminal going quiet after sustained output as "done". */
  notifyOnQuiet: boolean
  /** Reveal and focus the pane that notified. */
  autoSwitch: boolean
  /** Show the number of waiting panes on the Dock icon. */
  dockBadge: boolean
  /** Also post to macOS Notification Center while the app is in the background. */
  systemNotifications: boolean
}

const STORAGE_KEY = 'beads-station.notification-preferences'
const DEFAULTS: NotificationPreferences = { enabled: true, notifyOnQuiet: true, autoSwitch: false, dockBadge: true, systemNotifications: false, sounds: DEFAULT_SOUNDS }

function load(): NotificationPreferences {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<NotificationPreferences>
    return {
      enabled: parsed.enabled !== false,
      notifyOnQuiet: parsed.notifyOnQuiet !== false,
      autoSwitch: parsed.autoSwitch === true,
      dockBadge: parsed.dockBadge !== false,
      systemNotifications: parsed.systemNotifications === true,
      sounds: loadSounds(parsed.sounds),
    }
  } catch {
    return { ...DEFAULTS }
  }
}

let state = load()
const listeners = new Set<() => void>()

export function subscribeNotificationPreferences(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getNotificationPreferences(): NotificationPreferences {
  return state
}

export function useNotificationPreferences(): NotificationPreferences {
  return useSyncExternalStore(subscribeNotificationPreferences, getNotificationPreferences, getNotificationPreferences)
}

export function setNotificationPreferences(next: Partial<NotificationPreferences>): void {
  const updated = { ...state, ...next }
  if ((Object.keys(updated) as (keyof NotificationPreferences)[]).every(key => key === 'sounds' ? JSON.stringify(updated.sounds) === JSON.stringify(state.sounds) : updated[key] === state[key])) return
  state = updated
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* optional */ }
  persistDurableUserConfigKey(STORAGE_KEY)
  listeners.forEach(listener => listener())
}
