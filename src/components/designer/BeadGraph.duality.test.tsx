import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

// RV8.4 — bead-pane duality. Clicking a READY node in the graph must spawn a
// Claude agent pane targeting the active project (plan posture); non-ready nodes
// (blocked/in_progress/closed) are inert. We mock the four seams (projects,
// bd snapshot, live provider, spawnAgent) and drive clicks through the DOM.

interface FakeIssue {
  id: string
  title: string
  status: string
  dependencies?: { issue_id: string; depends_on_id: string }[]
}

const READY = { id: 'Code-ready', title: 'Ready bead', status: 'open' }
const BLOCKED = {
  id: 'Code-blocked',
  title: 'Blocked bead',
  status: 'open',
  dependencies: [{ issue_id: 'Code-blocked', depends_on_id: 'Code-ready' }],
}

const spawnAgentMock = vi.fn()
const setSkinMock = vi.fn()

vi.mock('../../state/termPanes', () => ({
  spawnAgent: (...args: unknown[]) => spawnAgentMock(...args),
}))

vi.mock('../../state/skin', () => ({
  setSkin: (...args: unknown[]) => setSkinMock(...args),
}))

vi.mock('../../state/projects', () => ({
  useProjects: () => ({
    projects: [{ id: 'proj-1', name: 'Beads', path: '/repo/beads' }],
    activeId: 'proj-1',
  }),
}))

vi.mock('../../lib/BdLiveProvider', () => ({
  BdLiveProvider: ({ children }: { children: ReactNode }) => children,
}))

// Snapshot: both beads present; only Code-ready is in `ready` (Code-blocked has
// an open blocker so it classifies as blocked).
vi.mock('../../lib/bdCache', () => ({
  useBdSnapshot: () => ({
    ready: [READY],
    all: [READY, BLOCKED] as FakeIssue[],
    loaded: true,
    error: null,
  }),
}))

// crypto.randomUUID is used for the sessionId; jsdom may not provide it.
if (!globalThis.crypto?.randomUUID) {
  // @ts-expect-error test shim
  globalThis.crypto = { ...globalThis.crypto, randomUUID: () => 'test-uuid' }
}

import { BeadGraph } from './BeadGraph'

describe('BeadGraph bead-pane duality', () => {
  beforeEach(() => {
    spawnAgentMock.mockClear()
    setSkinMock.mockClear()
  })

  it('clicking a READY node spawns an agent pane and switches to the terminal skin', () => {
    render(<BeadGraph />)
    const node = document.querySelector('[data-bs-bead-node="Code-ready"]') as HTMLElement
    expect(node).toBeTruthy()
    expect(node.getAttribute('data-bs-bead-state')).toBe('ready')
    node.click()
    expect(spawnAgentMock).toHaveBeenCalledTimes(1)
    const [projectId, cwd, sessionId, mode] = spawnAgentMock.mock.calls[0]
    expect(projectId).toBe('proj-1')
    expect(cwd).toBe('/repo/beads')
    expect(typeof sessionId).toBe('string')
    expect(mode).toBe('plan')
    // Agent panes render in the terminal skin, so the click lands you on the pane.
    expect(setSkinMock).toHaveBeenCalledWith('terminal')
  })

  it('clicking a BLOCKED node is inert (no spawn)', () => {
    render(<BeadGraph />)
    const node = document.querySelector('[data-bs-bead-node="Code-blocked"]') as HTMLElement
    expect(node).toBeTruthy()
    expect(node.getAttribute('data-bs-bead-state')).toBe('blocked')
    node.click()
    expect(spawnAgentMock).not.toHaveBeenCalled()
  })

  it('renders the state locator attr on every node', () => {
    render(<BeadGraph />)
    expect(screen.getByText('Ready bead')).toBeTruthy()
    expect(document.querySelectorAll('[data-bs-bead-node]').length).toBe(2)
  })
})
