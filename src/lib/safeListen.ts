// Beads Station — R1 (Pillar 2: async-cleanup discipline)
//
// Signal-based listener helper. The bug this eliminates, written three
// times across the app: an async IIFE registers Tauri listeners across
// multiple `await` boundaries with no cancelled-check between awaits.
// React StrictMode fires unmount+remount in dev; cleanup lands between
// `claude_start` and the first `listen()`, and the resulting unlisten
// handle is never stored — leaked forever.
//
// The fix is one helper that respects an AbortSignal:
//   - if the signal is already aborted, don't even listen
//   - after the (async) listen resolves, re-check the signal; if it
//     aborted mid-await, immediately unlisten and bail
//   - otherwise wire the signal's `abort` event to the unlisten
//
// Callers no longer track `cancelled` booleans or `unlisten` handles by
// hand — they create one AbortController per effect and abort it in the
// cleanup return. All listeners registered against that signal tear down
// atomically, regardless of which await boundary the abort raced.
//
// Reconciliation with R0: R0 shipped a `safeListen(channel, handler,
// options): Promise<UnlistenFn>` in listenerRegistry.ts that feeds the
// dev telemetry overlay's per-channel listener counts. We route THROUGH
// that (imported as `registryListen`) rather than raw `listen()`, so the
// F12 overlay's baseline-return verification stays observable. This
// helper is the abort-aware layer on top; the registry is the counting
// layer underneath.

import { type EventCallback } from '@tauri-apps/api/event'
import { safeListen as registryListen } from './listenerRegistry'

/**
 * Register a Tauri event listener that tears down when `signal` aborts.
 *
 * Safe across await boundaries: if the signal is (or becomes) aborted
 * before the underlying listen resolves, the listener is unlistened
 * immediately and never leaks. Resolves once the listener is armed (or
 * once it's determined the signal aborted first).
 *
 * @param channel  Tauri event channel, e.g. `claude_event:${projectId}`
 * @param handler  event callback
 * @param signal   AbortSignal; abort it in the effect cleanup to unlisten
 */
export async function safeListen<T>(
  channel: string,
  handler: EventCallback<T>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return
  const unlisten = await registryListen<T>(channel, handler)
  if (signal.aborted) {
    unlisten()
    return
  }
  signal.addEventListener('abort', () => unlisten(), { once: true })
}
