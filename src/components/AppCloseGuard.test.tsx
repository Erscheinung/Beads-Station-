import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listener: null as null | ((event: { payload: { source: 'window' } }) => void),
  flushScreens: vi.fn(),
  flushPanes: vi.fn(),
  clean: vi.fn(),
  boot: vi.fn(() => false),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../lib/listenerRegistry', () => ({ safeListen: vi.fn(async (_name: string, listener: typeof mocks.listener) => { mocks.listener = listener; return vi.fn() }) }))
vi.mock('../lib/terminalSessions', () => ({ flushTerminalSessionScreens: mocks.flushScreens }))
vi.mock('../state/termPanes', () => ({ flushTermPanePersistence: mocks.flushPanes }))
vi.mock('../state/rendererLifecycle', () => ({ markRendererBoot: mocks.boot, markRendererActive: vi.fn(), markRendererCleanExit: mocks.clean }))

import { AppCloseGuard } from './AppCloseGuard'

describe('AppCloseGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listener = null
    mocks.boot.mockReturnValue(false)
    mocks.invoke.mockImplementation(async command => command === 'app_close_scope'
      ? { ptyCount: 2, providerCount: 1, runCount: 1 }
      : null)
  })

  it('deduplicates overlapping requests and Cancel restores focus without stopping sessions', async () => {
    const input = document.body.appendChild(document.createElement('input'))
    input.focus()
    render(<AppCloseGuard />)
    await act(async () => {})
    act(() => {
      mocks.listener?.({ payload: { source: 'window' } })
      mocks.listener?.({ payload: { source: 'window' } })
    })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    await screen.findByText(/2 terminals, 1 provider session, and 1 active run/)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => {})
    expect(mocks.invoke).toHaveBeenCalledWith('app_resolve_close', { stopSessions: false })
    expect(mocks.flushScreens).not.toHaveBeenCalled()
    expect(mocks.clean).not.toHaveBeenCalled()
    await waitFor(() => expect(document.activeElement).toBe(input))
    input.remove()
  })

  it('checkpoints saved context before asking native ownership to stop', async () => {
    render(<AppCloseGuard />)
    await act(async () => {})
    fireEvent.keyDown(window, { key: 'q', metaKey: true })
    await screen.findByText(/2 terminals, 1 provider session, and 1 active run/)
    fireEvent.click(screen.getByRole('button', { name: 'Close and stop sessions' }))
    await act(async () => {})
    expect(mocks.flushScreens).toHaveBeenCalledOnce()
    expect(mocks.flushPanes).toHaveBeenCalledOnce()
    expect(mocks.clean).toHaveBeenCalledOnce()
    expect(mocks.invoke).toHaveBeenCalledWith('app_resolve_close', { stopSessions: true })
  })

  it('reaps stale app-owned children after an ungraceful renderer exit without starting providers', async () => {
    mocks.boot.mockReturnValue(true)
    render(<AppCloseGuard />)
    await act(async () => {})
    expect(mocks.invoke).toHaveBeenCalledWith('app_recover_stale_sessions')
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'claude_start' || command === 'codex_chat_start' || command === 'codex_chat_send')).toBe(false)
  })
})
