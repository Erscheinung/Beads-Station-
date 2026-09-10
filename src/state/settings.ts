import { useSyncExternalStore } from 'react'
let open = false
const listeners = new Set<() => void>()
export function openSettings() { open = true; listeners.forEach(l => l()) }
export function closeSettings() { open = false; listeners.forEach(l => l()) }
export function useSettingsOpen() { return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l) } }, () => open) }
