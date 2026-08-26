import { afterEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Code-bqz — safeListen must not let a rejected Tauri listen() poison the
// caller's async effect body.
//
// Real bug: a flapping pane (rapid mount/abort) made Tauri's listen()/unlisten
// reject with "listeners[eventId].handlerId". ClaudeChat's mount effect awaits
// four safeListen()s BEFORE its own invoke('claude_start'). An unguarded reject
// aborted the whole IIFE, so the backend claude child was never spawned. We
// mock the registry seam (which wraps @tauri-apps/api/event listen()) and prove
// safeListen swallows the reject to a resolved no-op.
// ---------------------------------------------------------------------------

const registryListenMock = vi.fn()

vi.mock('./listenerRegistry', () => ({
  safeListen: (...args: unknown[]) => registryListenMock(...args),
}))

import { safeListen } from './safeListen'

afterEach(() => {
  registryListenMock.mockReset()
  vi.restoreAllMocks()
})

describe('safeListen', () => {
  it('resolves (does not reject) when the underlying listen rejects', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    registryListenMock.mockRejectedValueOnce(
      new TypeError("undefined is not an object (evaluating 'listeners[eventId].handlerId')"),
    )
    const ac = new AbortController()
    // Must NOT throw — the whole point is that a downstream invoke can still run.
    await expect(safeListen('claude_event:All_Doors', () => {}, ac.signal)).resolves.toBeUndefined()
  })

  it('a rejected listen does not block a subsequent statement in the same async body', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    registryListenMock.mockRejectedValueOnce(new Error('handlerId'))
    const spawn = vi.fn()
    // Mirror ClaudeChat's shape: await the listen, THEN spawn.
    await (async () => {
      await safeListen('claude_event:x', () => {}, new AbortController().signal)
      spawn()
    })()
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('arms the listener and wires abort-driven unlisten on the happy path', async () => {
    const unlisten = vi.fn()
    registryListenMock.mockResolvedValueOnce(unlisten)
    const ac = new AbortController()
    await safeListen('claude_event:y', () => {}, ac.signal)
    expect(unlisten).not.toHaveBeenCalled()
    ac.abort()
    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('unlistens immediately if the signal aborts during the listen await', async () => {
    const unlisten = vi.fn()
    const ac = new AbortController()
    registryListenMock.mockImplementationOnce(async () => {
      ac.abort()
      return unlisten
    })
    await safeListen('claude_event:z', () => {}, ac.signal)
    expect(unlisten).toHaveBeenCalledOnce()
  })
})
