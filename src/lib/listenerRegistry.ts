// Beads Station — R0
// Dev-time listener registry. Thin wrapper over tauri's listen() that
// counts active handles by channel-name prefix (the substring before the
// first colon, or the whole channel if no colon). Prefix bucket keeps the
// count meaningful when channels are per-project (claude_event:{pid}) —
// otherwise every project would look like a "new" channel.
//
// In production this returns raw listen() unchanged. In dev, tracks and
// reports. No cleanup needed — the reg is process-lifetime; each
// unsubscribe just decrements.

import { listen, type EventCallback, type Options, type UnlistenFn } from '@tauri-apps/api/event'

type CountMap = Record<string, number>

const counts: CountMap = Object.create(null)
const listeners = new Set<() => void>()

// Cached immutable snapshot for useSyncExternalStore. getSnapshot MUST return
// a stable reference between changes — returning a fresh `{ ...counts }` each
// call makes React see every render as a store change and loops forever
// ("The result of getSnapshot should be cached to avoid an infinite loop").
// We rebuild this snapshot only inside notify(), i.e. only when counts change.
let snapshot: CountMap = Object.create(null)

function bucketOf(channel: string): string {
  const i = channel.indexOf(':')
  return i === -1 ? channel : channel.slice(0, i)
}

function notify(): void {
  // Rebuild the immutable snapshot once per real mutation, then fan out.
  snapshot = { ...counts }
  for (const cb of listeners) cb()
}

export async function safeListen<T>(
  channel: string,
  handler: EventCallback<T>,
  options?: Options,
): Promise<UnlistenFn> {
  const bucket = bucketOf(channel)
  const unlisten = await listen<T>(channel, handler, options)
  if (import.meta.env.DEV) {
    counts[bucket] = (counts[bucket] ?? 0) + 1
    notify()
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (import.meta.env.DEV) {
      counts[bucket] = Math.max(0, (counts[bucket] ?? 0) - 1)
      notify()
    }
    unlisten()
  }
}

export function getListenerCounts(): CountMap {
  // Return the cached immutable snapshot (stable reference between changes).
  // Rebuilt only in notify() when counts actually mutate. Callers must not
  // mutate it.
  return snapshot
}

export function subscribeListenerCounts(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
