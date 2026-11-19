import { useSyncExternalStore } from 'react'
import { persistDurableUserConfigKey } from '../lib/durableUserConfig'

// "no beads db" in the status bar is a button that opens the Initialize Beads
// flow. A folder that is never meant to have tickets can be silenced for good.
// Stored per folder path, so other workspaces keep their hint.
export const BEADS_SETUP_HINT_KEY = 'beads-station.beads-setup-dismissed.v1'

function load(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(BEADS_SETUP_HINT_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((path): path is string => typeof path === 'string') : []
  } catch { return [] }
}

let dismissed = load()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(listener => listener())

export function isBeadsSetupDismissed(path: string): boolean {
  return dismissed.includes(path)
}

export function setBeadsSetupDismissed(path: string, value: boolean): void {
  const has = dismissed.includes(path)
  if (has === value) return
  dismissed = value ? [...dismissed, path] : dismissed.filter(item => item !== path)
  try { localStorage.setItem(BEADS_SETUP_HINT_KEY, JSON.stringify(dismissed)) } catch { /* optional storage */ }
  persistDurableUserConfigKey(BEADS_SETUP_HINT_KEY)
  emit()
}

export function useBeadsSetupDismissed(path: string): boolean {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    () => dismissed.includes(path),
  )
}

/** Test hook: forget the in-memory copy so the next read comes from storage. */
export function __resetBeadsSetupHintForTest(): void {
  dismissed = load()
  emit()
}
