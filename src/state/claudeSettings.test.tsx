import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import React from 'react'

// ---------------------------------------------------------------------------
// R3.5 render-loop regression test for PermissionModePicker.
//
// The bug: the picker's host-finding effect retried `document.getElementById`
// on a setTimeout(find,16) chain. The old code (a) never returned after finding
// the host so the retry chain could dangle, (b) called setHost unconditionally
// (no identity guard), and (c) never cleared the timer on cleanup. Under
// StrictMode's double-mount plus a sibling re-render burst this produced
// "Maximum update depth exceeded".
//
// The fix: setHost uses a functional updater `prev === el ? prev : el`, returns
// immediately once found, bounds retries to 10, and clears the timer on
// cleanup. Additionally usePermissionMode memoizes setMode (useCallback) and its
// return object (useMemo).
//
// We mock the two Tauri seams the same way Board.test.tsx mocks tauri: the
// plugin-store `Store` (Store.load + store.get during hydration, store.set /
// store.save on write) and @tauri-apps/api/core `invoke` (called on setMode).
// All stubs resolve to empty/default values so nothing rejects mid-render.
// ---------------------------------------------------------------------------

// invoke() is called by usePermissionMode.setMode via claude_set_permission_mode.
const invokeMock = vi.fn(async () => undefined)

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...(args as [])),
}))

// The picker hydrates via Store.load(file).then(store => store.get(key)). Model
// a Store instance with get/set/save that all resolve — get returns undefined so
// the hook falls back to its safe 'acceptEdits' default (a persisted value is
// not needed to exercise the mount/settle path).
const storeGet = vi.fn(async () => undefined)
const storeSet = vi.fn(async () => undefined)
const storeSave = vi.fn(async () => undefined)

const fakeStore = { get: storeGet, set: storeSet, save: storeSave }

vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: vi.fn(async () => fakeStore),
  },
}))

import { PermissionModePicker } from './claudeSettings'

// RV2 — the host id is now bridge-scoped: `bs-claude-header-right-${bridge}`,
// where bridge defaults to projectId. The tests below render the picker with
// projectId="p1" (bridge omitted), so the host id is the p1-suffixed one.
const HOST_ID = 'bs-claude-header-right-p1'

function makeHost(): HTMLDivElement {
  const el = document.createElement('div')
  el.id = HOST_ID
  document.body.appendChild(el)
  return el
}

describe('PermissionModePicker render-loop regression', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    invokeMock.mockClear()
    storeGet.mockClear()
    storeSet.mockClear()
    storeSave.mockClear()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
    // Clean any host node between tests so absence-case starts clean.
    document.getElementById(HOST_ID)?.remove()
  })

  it('mounts and settles under StrictMode without a "Maximum update depth" loop', async () => {
    makeHost()

    render(
      <React.StrictMode>
        <PermissionModePicker projectId="p1" />
      </React.StrictMode>,
    )

    // The picker portals into the host once hydration resolves. If the render
    // loop regressed, React would throw "Maximum update depth exceeded" before
    // ever reaching a stable radiogroup — so simply awaiting it is the guard.
    await waitFor(() =>
      expect(
        screen.getByRole('radiogroup', { name: 'claude permission mode' }),
      ).toBeInTheDocument(),
    )

    // The three permission-mode pills render inside the portal host.
    expect(screen.getAllByRole('radio')).toHaveLength(3)

    // No update-depth error was logged during mount/settle.
    const loggedUpdateDepth = errorSpy.mock.calls.some(call =>
      call.some(
        arg => typeof arg === 'string' && arg.includes('Maximum update depth'),
      ),
    )
    expect(loggedUpdateDepth).toBe(false)
  })

  // RV2 — bridge-scoped portal id. Two agent panes on the SAME project pass
  // distinct bridgeIds and must portal into DISTINCT host nodes; the picker for
  // bridge "agent7" must NOT attach to the p1 host, proving no collision.
  it('portals into the bridge-scoped host, not the project host', async () => {
    // Legacy host (bridge == projectId) present, agent host present too.
    makeHost() // bs-claude-header-right-p1
    const agentHost = document.createElement('div')
    agentHost.id = 'bs-claude-header-right-agent7'
    document.body.appendChild(agentHost)

    render(
      <React.StrictMode>
        <PermissionModePicker projectId="p1" bridgeId="agent7" />
      </React.StrictMode>,
    )

    await waitFor(() =>
      expect(
        screen.getByRole('radiogroup', { name: 'claude permission mode' }),
      ).toBeInTheDocument(),
    )
    // The radiogroup lives inside the agent7 host, not the p1 host.
    expect(agentHost.querySelector('[role="radiogroup"]')).not.toBeNull()
    expect(document.getElementById(HOST_ID)?.querySelector('[role="radiogroup"]')).toBeNull()

    agentHost.remove()
  })

  it('renders null when the portal host is absent and does not infinite-retry', async () => {
    // No makeHost() here: the host never appears. The bounded
    // retry chain (<=10 frames) must give up quietly — no radiogroup, no crash,
    // no update-depth error.
    render(
      <React.StrictMode>
        <PermissionModePicker projectId="p1" />
      </React.StrictMode>,
    )

    // Give the retry chain (~10 * 16ms) more than enough real time to run out.
    await new Promise(r => setTimeout(r, 250))

    expect(
      screen.queryByRole('radiogroup', { name: 'claude permission mode' }),
    ).toBeNull()

    const loggedUpdateDepth = errorSpy.mock.calls.some(call =>
      call.some(
        arg => typeof arg === 'string' && arg.includes('Maximum update depth'),
      ),
    )
    expect(loggedUpdateDepth).toBe(false)
  })
})
