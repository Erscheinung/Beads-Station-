import { afterEach, describe, expect, it, vi } from 'vitest'

// RV5.1 (Code-qqa) — senseBridge invoke arg-shape guard. The Rust commands read
// camelCase `repoPath` (Tauri renames snake_case params), so the bridge MUST
// pass { repoPath } not { repo_path }; a mismatch silently no-ops the call.

const invokeMock = vi.fn((..._args: unknown[]) => Promise.resolve(undefined))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

import {
  senseList,
  sensePromote,
  senseDismiss,
  senseScan,
  senseWatchStart,
  senseWatchStop,
} from './senseBridge'

const REPO = '/repo/a'

describe('senseBridge', () => {
  afterEach(() => invokeMock.mockClear())

  it('senseList -> sense_list { repoPath }', () => {
    void senseList(REPO)
    expect(invokeMock).toHaveBeenCalledWith('sense_list', { repoPath: REPO })
  })

  it('sensePromote -> sense_promote { repoPath, id }', () => {
    void sensePromote(REPO, 'Code-wisp-x')
    expect(invokeMock).toHaveBeenCalledWith('sense_promote', { repoPath: REPO, id: 'Code-wisp-x' })
  })

  it('senseDismiss -> sense_dismiss { repoPath, id }', () => {
    void senseDismiss(REPO, 'Code-wisp-x')
    expect(invokeMock).toHaveBeenCalledWith('sense_dismiss', { repoPath: REPO, id: 'Code-wisp-x' })
  })

  it('senseScan -> sense_scan { repoPath }', () => {
    void senseScan(REPO)
    expect(invokeMock).toHaveBeenCalledWith('sense_scan', { repoPath: REPO })
  })

  it('senseWatchStart -> sense_watch_start with empty dirs (Rust owns paths)', () => {
    void senseWatchStart()
    expect(invokeMock).toHaveBeenCalledWith('sense_watch_start', { dirs: [] })
  })

  it('senseWatchStop -> sense_watch_stop', () => {
    void senseWatchStop()
    expect(invokeMock).toHaveBeenCalledWith('sense_watch_stop')
  })
})
