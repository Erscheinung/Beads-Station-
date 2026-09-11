import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('designer native run reconciliation', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })

  it('merges a snapshot/event race in sequence and never starts during repeated reconciliation', async () => {
    const runId = 'workspace-a:Code-one:attempt-one'
    localStorage.setItem('beads-station.designer-runs.v1', JSON.stringify([{
      key: 'workspace-a:Code-one', runId, workspaceId: 'workspace-a', ticketId: 'Code-one',
      attemptId: 'attempt-one', provider: 'codex', status: 'running', output: [],
    }]))
    const handlers = new Map<string, (event: { payload: any }) => void>()
    let releaseSnapshot!: (value: unknown) => void
    const firstSnapshot = new Promise(resolve => { releaseSnapshot = resolve })
    let snapshotValue: unknown = []
    let calls = 0
    const invoke = vi.fn().mockImplementation(() => {
      calls += 1
      if (calls === 1) return firstSnapshot
      if (calls === 2) return snapshotValue
      return []
    })
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }))
    vi.doMock('../../lib/listenerRegistry', () => ({
      safeListen: vi.fn(async (channel: string, handler: (event: { payload: any }) => void) => { handlers.set(channel, handler); return vi.fn() }),
    }))

    const { reconcileNativeRuns } = await import('./nativeRuns')
    const reconciling = reconcileNativeRuns('workspace-a')
    await vi.waitFor(() => expect(handlers.size).toBe(1))
    handlers.values().next().value!({ payload: { seq: 2, kind: 'output', parsed: { text: 'two' } } })
    snapshotValue = [{
      runId, workspaceId: 'workspace-a', ticketId: 'Code-one', attemptId: 'attempt-one', provider: 'codex', status: 'running',
      events: [{ seq: 1, kind: 'output', parsed: { text: 'one' } }],
    }]
    releaseSnapshot(snapshotValue)
    await reconciling

    let saved = JSON.parse(localStorage.getItem('beads-station.designer-runs.v1')!)[0]
    expect(saved).toMatchObject({ runId, workspaceId: 'workspace-a', ticketId: 'Code-one', attemptId: 'attempt-one', provider: 'codex', status: 'running' })
    expect(saved.output).toEqual(['one', 'two'])

    await reconcileNativeRuns('workspace-a')
    saved = JSON.parse(localStorage.getItem('beads-station.designer-runs.v1')!)[0]
    expect(saved.status).toBe('unknown')
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'native_run_snapshot', 'native_run_snapshot', 'native_run_snapshot', 'native_run_snapshot',
    ])
    expect(invoke).not.toHaveBeenCalledWith('native_run_start', expect.anything())
  })

  it('closes the discovery gap for a backend-only run', async () => {
    const runId = 'workspace-b:Code-two:attempt-two'
    const snapshot = [{
      runId, workspaceId: 'workspace-b', ticketId: 'Code-two', attemptId: 'attempt-two', provider: 'claude', status: 'running',
      events: [{ seq: 1, kind: 'output', parsed: { text: 'discovered' } }],
    }]
    const handlers = new Map<string, (event: { payload: any }) => void>()
    let finishSecond!: (value: unknown) => void
    const secondSnapshot = new Promise(resolve => { finishSecond = resolve })
    let calls = 0
    const invoke = vi.fn().mockImplementation(() => (++calls === 1 ? snapshot : secondSnapshot))
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }))
    vi.doMock('../../lib/listenerRegistry', () => ({
      safeListen: vi.fn(async (channel: string, handler: (event: { payload: any }) => void) => { handlers.set(channel, handler); return vi.fn() }),
    }))

    const { reconcileNativeRuns } = await import('./nativeRuns')
    const pending = reconcileNativeRuns('workspace-b')
    await vi.waitFor(() => expect(handlers.size).toBe(1))
    handlers.values().next().value!({ payload: { seq: 2, kind: 'output', parsed: { text: 'during-attach' } } })
    finishSecond(snapshot)
    await pending

    const saved = JSON.parse(localStorage.getItem('beads-station.designer-runs.v1')!)[0]
    expect(saved.output).toEqual(['discovered', 'during-attach'])
    expect(saved).toMatchObject({ runId, attemptId: 'attempt-two', status: 'running' })
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('keeps a transport-rejected start unknown after backend reconciliation', async () => {
    const invoke = vi.fn().mockImplementation((command: string) => {
      if (command === 'native_run_start') return Promise.reject(new Error('response lost'))
      if (command === 'native_run_snapshot') return Promise.resolve([{
        runId: 'workspace-c:Code-three:older-attempt', workspaceId: 'workspace-c', ticketId: 'Code-three',
        attemptId: 'older-attempt', provider: 'claude', status: 'needs_review',
        events: [{ seq: 1, kind: 'status', status: 'needs_review' }],
      }])
      return Promise.resolve(null)
    })
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }))
    vi.doMock('../../lib/listenerRegistry', () => ({ safeListen: vi.fn(async () => vi.fn()) }))
    const { startNativeRun } = await import('./nativeRuns')

    await startNativeRun('workspace-c:Code-three', {
      runId: 'workspace-c:Code-three:attempt-three', workspaceId: 'workspace-c', ticketId: 'Code-three',
      attemptId: 'attempt-three', provider: 'codex', cwd: '/tmp', prompt: 'fake only',
    })

    const saved = JSON.parse(localStorage.getItem('beads-station.designer-runs.v1')!)[0]
    expect(saved.status).toBe('unknown')
    expect(saved.runId).toBe('workspace-c:Code-three:attempt-three')
    expect(saved.output[0]).toContain('Start was not confirmed')
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'native_run_start', 'native_run_snapshot', 'native_run_snapshot',
    ])
  })

  it('reconnects a rejected start to the different active attempt owning the ticket', async () => {
    const activeRunId = 'workspace-c2:Code-three:already-active'
    const active = [{
      runId: activeRunId, workspaceId: 'workspace-c2', ticketId: 'Code-three', attemptId: 'already-active',
      provider: 'claude', status: 'running', events: [
        { seq: 1, kind: 'status', status: 'running' },
        { seq: 2, kind: 'output', parsed: { text: 'existing run' } },
      ],
    }]
    const invoke = vi.fn().mockImplementation((command: string) => {
      if (command === 'native_run_start') return Promise.reject(new Error('ticket already has an active native run'))
      if (command === 'native_run_snapshot') return Promise.resolve(active)
      return Promise.resolve(null)
    })
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }))
    vi.doMock('../../lib/listenerRegistry', () => ({ safeListen: vi.fn(async () => vi.fn()) }))
    const { startNativeRun } = await import('./nativeRuns')

    await startNativeRun('workspace-c2:Code-three', {
      runId: 'workspace-c2:Code-three:rejected-attempt', workspaceId: 'workspace-c2', ticketId: 'Code-three',
      attemptId: 'rejected-attempt', provider: 'codex', cwd: '/tmp', prompt: 'fake only',
    })

    const saved = JSON.parse(localStorage.getItem('beads-station.designer-runs.v1')!)[0]
    expect(saved).toMatchObject({
      runId: activeRunId, attemptId: 'already-active', provider: 'claude', status: 'running', output: ['existing run'],
    })
  })

  it('keeps snapshot status authoritative over historical events while accepting a later live status', async () => {
    const runId = 'workspace-d:Code-four:attempt-four'
    localStorage.setItem('beads-station.designer-runs.v1', JSON.stringify([{
      key: 'workspace-d:Code-four', runId, workspaceId: 'workspace-d', ticketId: 'Code-four',
      attemptId: 'attempt-four', provider: 'claude', status: 'running', output: [],
    }]))
    const snapshot = [{
      runId, workspaceId: 'workspace-d', ticketId: 'Code-four', attemptId: 'attempt-four', provider: 'claude', status: 'unknown',
      events: [
        { seq: 1, kind: 'status', status: 'running' },
        { seq: 2, kind: 'output', parsed: { text: 'before status check failed' } },
      ],
    }]
    let handler!: (event: { payload: any }) => void
    vi.doMock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(snapshot) }))
    vi.doMock('../../lib/listenerRegistry', () => ({
      safeListen: vi.fn(async (_channel: string, next: (event: { payload: any }) => void) => { handler = next; return vi.fn() }),
    }))

    const { reconcileNativeRuns } = await import('./nativeRuns')
    await reconcileNativeRuns('workspace-d')

    let saved = JSON.parse(localStorage.getItem('beads-station.designer-runs.v1')!)[0]
    expect(saved.status).toBe('unknown')
    expect(saved.output).toEqual(['before status check failed'])

    handler({ payload: { seq: 3, kind: 'status', status: 'cancelled' } })
    saved = JSON.parse(localStorage.getItem('beads-station.designer-runs.v1')!)[0]
    expect(saved.status).toBe('cancelled')
  })

  it('does not let an in-flight snapshot replace a newly started attempt', async () => {
    const key = 'workspace-e:Code-five'
    const oldRunId = `${key}:attempt-old`
    const newRunId = `${key}:attempt-new`
    localStorage.setItem('beads-station.designer-runs.v1', JSON.stringify([{
      key, runId: oldRunId, workspaceId: 'workspace-e', ticketId: 'Code-five',
      attemptId: 'attempt-old', provider: 'codex', status: 'needs_review', output: ['old result'],
    }]))
    const oldSnapshot = [{
      runId: oldRunId, workspaceId: 'workspace-e', ticketId: 'Code-five', attemptId: 'attempt-old', provider: 'codex', status: 'needs_review',
      events: [{ seq: 1, kind: 'status', status: 'running' }, { seq: 2, kind: 'status', status: 'needs_review' }],
    }]
    let releaseFirst!: (value: unknown) => void
    const firstSnapshot = new Promise(resolve => { releaseFirst = resolve })
    let snapshotCalls = 0
    const invoke = vi.fn().mockImplementation((command: string) => {
      if (command === 'native_run_snapshot') return ++snapshotCalls === 1 ? firstSnapshot : Promise.resolve(oldSnapshot)
      return Promise.resolve(null)
    })
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }))
    vi.doMock('../../lib/listenerRegistry', () => ({ safeListen: vi.fn(async () => vi.fn()) }))

    const { reconcileNativeRuns, startNativeRun } = await import('./nativeRuns')
    const reconciling = reconcileNativeRuns('workspace-e')
    await vi.waitFor(() => expect(snapshotCalls).toBe(1))
    await startNativeRun(key, {
      runId: newRunId, workspaceId: 'workspace-e', ticketId: 'Code-five', attemptId: 'attempt-new',
      provider: 'claude', cwd: '/tmp', prompt: 'fake only',
    })
    releaseFirst(oldSnapshot)
    await reconciling

    const saved = JSON.parse(localStorage.getItem('beads-station.designer-runs.v1')!)[0]
    expect(saved).toMatchObject({ runId: newRunId, attemptId: 'attempt-new', provider: 'claude', status: 'starting' })
    expect(saved.output).toEqual([])
    expect(invoke).toHaveBeenCalledWith('native_run_start', expect.objectContaining({ runId: newRunId }))
  })

  it('adopts the backend active attempt when restored storage points to an older unknown run', async () => {
    const key = 'workspace-g:Code-seven'
    const oldRunId = `${key}:attempt-old`
    const activeRunId = `${key}:attempt-active`
    localStorage.setItem('beads-station.designer-runs.v1', JSON.stringify([{
      key, runId: oldRunId, workspaceId: 'workspace-g', ticketId: 'Code-seven',
      attemptId: 'attempt-old', provider: 'claude', status: 'unknown', output: ['stale output'],
    }]))
    const active = [{
      runId: activeRunId, workspaceId: 'workspace-g', ticketId: 'Code-seven', attemptId: 'attempt-active',
      provider: 'codex', status: 'running', events: [
        { seq: 1, kind: 'status', status: 'running' },
        { seq: 2, kind: 'output', parsed: { text: 'active attempt output' } },
      ],
    }]
    const invoke = vi.fn().mockResolvedValue(active)
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }))
    vi.doMock('../../lib/listenerRegistry', () => ({ safeListen: vi.fn(async () => vi.fn()) }))

    const { reconcileNativeRuns } = await import('./nativeRuns')
    await reconcileNativeRuns('workspace-g')

    const saved = JSON.parse(localStorage.getItem('beads-station.designer-runs.v1')!)[0]
    expect(saved).toMatchObject({
      runId: activeRunId, attemptId: 'attempt-active', provider: 'codex', status: 'running',
      output: ['active attempt output'],
    })
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('does not mark a new attempt unknown when an older snapshot request fails', async () => {
    const key = 'workspace-h:Code-eight'
    const oldRunId = `${key}:attempt-old`
    const newRunId = `${key}:attempt-new`
    localStorage.setItem('beads-station.designer-runs.v1', JSON.stringify([{
      key, runId: oldRunId, workspaceId: 'workspace-h', ticketId: 'Code-eight',
      attemptId: 'attempt-old', provider: 'claude', status: 'running', output: [],
    }]))
    let rejectSnapshot!: (error: unknown) => void
    const snapshot = new Promise((_resolve, reject) => { rejectSnapshot = reject })
    const handlers: Array<(event: { payload: any }) => void> = []
    const invoke = vi.fn().mockImplementation((command: string) => (
      command === 'native_run_snapshot' ? snapshot : Promise.resolve(null)
    ))
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }))
    vi.doMock('../../lib/listenerRegistry', () => ({
      safeListen: vi.fn(async (_channel: string, handler: (event: { payload: any }) => void) => { handlers.push(handler); return vi.fn() }),
    }))

    const { reconcileNativeRuns, startNativeRun } = await import('./nativeRuns')
    const checking = reconcileNativeRuns('workspace-h')
    await vi.waitFor(() => expect(handlers).toHaveLength(1))
    handlers[0]({ payload: { seq: 1, kind: 'status', status: 'needs_review' } })
    await startNativeRun(key, {
      runId: newRunId, workspaceId: 'workspace-h', ticketId: 'Code-eight', attemptId: 'attempt-new',
      provider: 'codex', cwd: '/tmp', prompt: 'fake only',
    })
    rejectSnapshot(new Error('snapshot unavailable'))
    await checking

    const saved = JSON.parse(localStorage.getItem('beads-station.designer-runs.v1')!)[0]
    expect(saved).toMatchObject({ runId: newRunId, attemptId: 'attempt-new', provider: 'codex', status: 'starting' })
  })

  it('runs a fresh reconciliation after cancel when an earlier status check is in flight', async () => {
    const key = 'workspace-f:Code-six'
    const runId = `${key}:attempt-six`
    localStorage.setItem('beads-station.designer-runs.v1', JSON.stringify([{
      key, runId, workspaceId: 'workspace-f', ticketId: 'Code-six',
      attemptId: 'attempt-six', provider: 'claude', status: 'running', output: [],
    }]))
    const running = [{
      runId, workspaceId: 'workspace-f', ticketId: 'Code-six', attemptId: 'attempt-six', provider: 'claude', status: 'running',
      events: [{ seq: 1, kind: 'status', status: 'running' }],
    }]
    const cancelled = [{
      ...running[0], status: 'cancelled',
      events: [...running[0].events, { seq: 2, kind: 'status', status: 'cancelled' }],
    }]
    let releaseFirst!: (value: unknown) => void
    const firstSnapshot = new Promise(resolve => { releaseFirst = resolve })
    let snapshotCalls = 0
    const invoke = vi.fn().mockImplementation((command: string) => {
      if (command === 'native_run_cancel') return Promise.resolve(null)
      if (command === 'native_run_snapshot') {
        snapshotCalls += 1
        if (snapshotCalls === 1) return firstSnapshot
        return Promise.resolve(snapshotCalls === 2 ? running : cancelled)
      }
      return Promise.resolve(null)
    })
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }))
    // No event is delivered: the terminal state must come from the post-cancel snapshot.
    vi.doMock('../../lib/listenerRegistry', () => ({ safeListen: vi.fn(async () => vi.fn()) }))

    const { cancelNativeRun, reconcileNativeRuns } = await import('./nativeRuns')
    const checking = reconcileNativeRuns('workspace-f')
    await vi.waitFor(() => expect(snapshotCalls).toBe(1))
    const cancelling = cancelNativeRun(key)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('native_run_cancel', { runId }))
    releaseFirst(running)
    await Promise.all([checking, cancelling])

    const saved = JSON.parse(localStorage.getItem('beads-station.designer-runs.v1')!)[0]
    expect(saved.status).toBe('cancelled')
    expect(snapshotCalls).toBe(4)
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'native_run_snapshot', 'native_run_cancel', 'native_run_snapshot', 'native_run_snapshot', 'native_run_snapshot',
    ])
  })
})
