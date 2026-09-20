import { beforeEach, describe, expect, it, vi } from 'vitest'

const identity = { workspaceId: 'fixture-workspace', ticketId: 'Code-game', runId: 'run-1', attemptId: 'attempt-1' }
function revision(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, revisionId: 'revision-1', capturedAt: 10, ...identity,
    workspacePath: '/tmp/beads-fixture', revisionHash: 'hash-1',
    files: [{ path: 'index.html', status: ' M', size: 21, contentHash: 'file-hash', content: '<h1>fixture</h1>', binary: false, truncated: false }],
    diff: null, validation: ['fixture check'], ...overrides,
  }
}
function approval(overrides: Record<string, unknown> = {}) {
  return { ...identity, revisionId: 'revision-1', revisionHash: 'hash-1', approvedAt: 20, ...overrides }
}

describe('designer artifact revisions', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })

  it('captures actual fixture identity, preserves history, and approves the exact verified revision', async () => {
    const invoke = vi.fn().mockImplementation((command: string) => {
      if (command === 'artifact_capture') return Promise.resolve(revision())
      if (command === 'artifact_verify') return Promise.resolve(true)
      if (command === 'artifact_approve') return Promise.resolve(approval())
      return Promise.resolve(null)
    })
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }))
    const artifacts = await import('./artifacts')

    const captured = await artifacts.captureArtifact(identity, '/tmp/beads-fixture')
    expect(captured.revisionId).toBe('revision-1')
    expect(invoke).toHaveBeenCalledWith('artifact_capture', { args: { ...identity, workspacePath: '/tmp/beads-fixture' } })
    const returnedApproval = await artifacts.approveArtifact(captured, 'needs_review')
    expect(returnedApproval).toMatchObject({ runId: identity.runId, attemptId: identity.attemptId, revisionId: 'revision-1', revisionHash: 'hash-1' })
    expect(invoke).toHaveBeenCalledWith('artifact_approve', { args: { revision: { ...identity, revisionId: 'revision-1', revisionHash: 'hash-1' } } })
    expect(artifacts.currentApproval(identity)).toMatchObject({ revisionId: 'revision-1' })
    expect(artifacts.latestArtifact(identity)?.files[0].path).toBe('index.html')
    expect(JSON.parse(localStorage.getItem('beads-station.designer-artifacts.v1')!)).toMatchObject({ revisions: [expect.anything()], approvals: [expect.anything()] })
  })

  it('rejects stale approvals, changed workspaces, and non-review run states', async () => {
    const invoke = vi.fn().mockImplementation((command: string) => {
      if (command === 'artifact_capture') return Promise.resolve(revision())
      if (command === 'artifact_verify') return Promise.resolve(false)
      return Promise.resolve(null)
    })
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }))
    const artifacts = await import('./artifacts')
    const first = await artifacts.captureArtifact(identity, '/tmp/beads-fixture')
    await expect(artifacts.approveArtifact(first, 'failed')).rejects.toThrow('needs_review')

    await expect(artifacts.approveArtifact(first, 'needs_review')).rejects.toThrow('Workspace changed')
    const second = { ...first, revisionId: 'revision-2', revisionHash: 'hash-2' }
    // A later capture is the current revision; the earlier approval is stale.
    invoke.mockImplementation((command: string) => command === 'artifact_capture' ? Promise.resolve(second) : Promise.resolve(true))
    await artifacts.captureArtifact(identity, '/tmp/beads-fixture')
    await expect(artifacts.approveArtifact(first, 'needs_review')).rejects.toThrow('stale')
    await expect(artifacts.approveArtifact(second, 'cancelled')).rejects.toThrow('needs_review')
  })

  it('records revision feedback and invalidates the prior ticket approval without exposing unsafe previews', async () => {
    const invoke = vi.fn().mockResolvedValue(revision())
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }))
    const artifacts = await import('./artifacts')
    const captured = await artifacts.captureArtifact(identity, '/tmp/beads-fixture')
    // Make approval persist without a provider/model call.
    invoke.mockImplementation((command: string) => {
      if (command === 'artifact_verify') return Promise.resolve(true)
      if (command === 'artifact_approve') return Promise.resolve(approval())
      return Promise.resolve(null)
    })
    await artifacts.approveArtifact(captured, 'needs_review')
    const feedback = artifacts.requestArtifactChanges(identity, 'Add keyboard focus and retest Restart.')
    expect(feedback.text).toContain('keyboard focus')
    expect(artifacts.currentApproval(identity)).toBeNull()
    expect(artifacts.artifactFeedback(identity)).toHaveLength(1)

    const unsafe = { ...captured, revisionId: 'unsafe', files: [{ ...captured.files[0], path: '../secret.txt' }] }
    // The service validates provider/IPC data before storing or rendering it.
    invoke.mockImplementation((command: string) => command === 'artifact_capture' ? Promise.resolve(unsafe) : Promise.resolve(true))
    await expect(artifacts.captureArtifact(identity, '/tmp/beads-fixture')).rejects.toThrow('unsafe path')
  })

  it('rejects bounded overflow and restores persisted revisions after module reload', async () => {
    const oversized = revision({ files: Array.from({ length: 257 }, (_, index) => ({ path: 'file-' + index + '.txt', status: 'A', size: 0, contentHash: 'x', content: '', binary: false, truncated: false })) })
    const invoke = vi.fn().mockResolvedValue(oversized)
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }))
    const artifacts = await import('./artifacts')
    await expect(artifacts.captureArtifact(identity, '/tmp/beads-fixture')).rejects.toThrow('invalid revision')

    localStorage.setItem('beads-station.designer-artifacts.v1', JSON.stringify({ schemaVersion: 1, revisions: [revision()], approvals: [], feedback: [] }))
    vi.resetModules()
    const restored = await import('./artifacts')
    expect(restored.latestArtifact(identity)?.revisionId).toBe('revision-1')
  })

  it('reconciles the durable backend revision and approval over stale browser state', async () => {
    const stale = revision({ revisionId: 'stale', revisionHash: 'stale-hash' })
    localStorage.setItem('beads-station.designer-artifacts.v1', JSON.stringify({
      schemaVersion: 1, revisions: [stale], approvals: [{ ...identity, revisionId: 'stale', revisionHash: 'stale-hash', approvedAt: 1 }], feedback: [],
    }))
    const durable = revision({ revisionId: 'durable', revisionHash: 'durable-hash' })
    const durableApproval = approval({ revisionId: 'durable', revisionHash: 'durable-hash' })
    const invoke = vi.fn().mockResolvedValue({ revision: durable, approval: durableApproval })
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }))
    const artifacts = await import('./artifacts')

    await artifacts.reconcileArtifactReview(identity)

    expect(artifacts.latestArtifact(identity)?.revisionId).toBe('durable')
    expect(artifacts.currentApproval(identity)?.revisionHash).toBe('durable-hash')
    expect(invoke).toHaveBeenCalledWith('artifact_review', { args: identity })
  })
})
