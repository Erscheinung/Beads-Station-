import { useSyncExternalStore } from 'react'
import { persistDurableUserConfigKey } from '../lib/durableUserConfig'

export interface NotificationPreferences {
  /** Mark panes that need attention (ring, tab dots). */
  enabled: boolean
  /** Also treat a background terminal going quiet after sustained output as "done". */
  notifyOnQuiet: boolean
  /** Reveal and focus the pane that notified. */
  autoSwitch: boolean
  /** Show the number of waiting panes on the Dock icon. */
  dockBadge: boolean
}

const STORAGE_KEY = 'beads-station.notification-preferences'
const DEFAULTS: NotificationPreferences = { enabled: true, notifyOnQuiet: true, autoSwitch: false, dockBadge: true }

function load(): NotificationPreferences {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<NotificationPreferences>
    return {
      enabled: parsed.enabled !== false,
      notifyOnQuiet: parsed.notifyOnQuiet !== false,
      autoSwitch: parsed.autoSwitch === true,
      dockBadge: parsed.dockBadge !== false,
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
  if ((Object.keys(updated) as (keyof NotificationPreferences)[]).every(key => updated[key] === state[key])) return
  state = updated
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* optional */ }
  persistDurableUserConfigKey(STORAGE_KEY)
  listeners.forEach(listener => listener())
}
