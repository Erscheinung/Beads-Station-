// Release check state. The backend reads the project's GitHub releases; this
// store holds the result for Settings > About and the toolbar notice. Nothing
// is installed automatically: a download opens the DMG in Finder.

import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { persistDurableUserConfigKey } from '../lib/durableUserConfig'

export interface UpdateInfo {
  current: string
  latest: string | null
  newer: boolean
  url: string | null
  asset: string | null
}

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'current'; info: UpdateInfo; checkedAt: number }
  | { status: 'available'; info: UpdateInfo; checkedAt: number }
  | { status: 'downloading'; info: UpdateInfo }
  | { status: 'downloaded'; info: UpdateInfo; path: string; checksumVerified: boolean }
  | { status: 'error'; message: string; info?: UpdateInfo }

const PREFERENCES_KEY = 'beads-station.update-preferences'

function loadCheckOnLaunch(): boolean {
  try {
    return (JSON.parse(localStorage.getItem(PREFERENCES_KEY) || '{}') as { checkOnLaunch?: boolean }).checkOnLaunch !== false
  } catch {
    return true
  }
}

let state: UpdateState = { status: 'idle' }
let checkOnLaunch = loadCheckOnLaunch()
const listeners = new Set<() => void>()

function set(next: UpdateState): void {
  state = next
  listeners.forEach(listener => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useAppUpdate(): UpdateState {
  return useSyncExternalStore(subscribe, () => state, () => state)
}

export function useCheckForUpdatesOnLaunch(): boolean {
  return useSyncExternalStore(subscribe, () => checkOnLaunch, () => checkOnLaunch)
}

export function setCheckForUpdatesOnLaunch(next: boolean): void {
  if (checkOnLaunch === next) return
  checkOnLaunch = next
  try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ checkOnLaunch })) } catch { /* optional */ }
  persistDurableUserConfigKey(PREFERENCES_KEY)
  listeners.forEach(listener => listener())
}

function isUpdateInfo(value: unknown): value is UpdateInfo {
  return !!value && typeof value === 'object' && typeof (value as UpdateInfo).current === 'string' && typeof (value as UpdateInfo).newer === 'boolean'
}

export async function checkForUpdates(): Promise<void> {
  if (state.status === 'checking' || state.status === 'downloading') return
  set({ status: 'checking' })
  try {
    const info = await invoke<unknown>('app_check_update')
    if (!isUpdateInfo(info)) throw new Error('The release check returned no result.')
    set({ status: info.newer ? 'available' : 'current', info, checkedAt: Date.now() })
  } catch (error) {
    set({ status: 'error', message: String(error instanceof Error ? error.message : error) })
  }
}

export async function downloadUpdate(): Promise<void> {
  if (state.status !== 'available' && !(state.status === 'error' && state.info?.newer)) return
  const info = state.info!
  if (!info.latest) return
  set({ status: 'downloading', info })
  try {
    const result = await invoke<{ path: string; checksumVerified: boolean }>('app_download_update', { tag: info.latest })
    set({ status: 'downloaded', info, path: result.path, checksumVerified: result.checksumVerified })
  } catch (error) {
    set({ status: 'error', message: String(error instanceof Error ? error.message : error), info })
  }
}

let launchCheckDone = false
/** One quiet check per app start, if the user has left it enabled. */
export function checkForUpdatesOnLaunch(): void {
  if (launchCheckDone || !checkOnLaunch) return
  launchCheckDone = true
  void checkForUpdates().then(() => {
    // A failed background check is not worth surfacing; a manual one is.
    if (state.status === 'error') set({ status: 'idle' })
  })
}

export function __resetAppUpdateForTest(): void {
  state = { status: 'idle' }
  checkOnLaunch = loadCheckOnLaunch()
  launchCheckDone = false
}
