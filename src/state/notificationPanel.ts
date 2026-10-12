import { useSyncExternalStore } from 'react'

let open = false
const listeners = new Set<() => void>()
function set(next: boolean) {
  if (open === next) return
  open = next
  listeners.forEach(listener => listener())
}
export const openNotificationPanel = () => set(true)
export const closeNotificationPanel = () => set(false)
export const toggleNotificationPanel = () => set(!open)
export function useNotificationPanelOpen() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => open, () => open)
}
