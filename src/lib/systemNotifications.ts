// macOS Notification Center alerts. Used only while the app is in the
// background, and only after the user has turned the setting on (which is
// when macOS asks for permission).

type NotificationApi = typeof import('@tauri-apps/plugin-notification')

async function api(): Promise<NotificationApi | null> {
  try { return await import('@tauri-apps/plugin-notification') } catch { return null }
}

/** Ask macOS for permission if it has not been decided yet. Call from a user action. */
export async function ensureSystemNotificationPermission(): Promise<boolean> {
  const plugin = await api()
  if (!plugin) return false
  try {
    if (await plugin.isPermissionGranted()) return true
    return (await plugin.requestPermission()) === 'granted'
  } catch {
    return false
  }
}

export function sendSystemNotification(title: string, body: string): void {
  void api().then(async plugin => {
    if (!plugin) return
    try {
      if (await plugin.isPermissionGranted()) plugin.sendNotification({ title, body })
    } catch { /* no notification service in this context */ }
  })
}
