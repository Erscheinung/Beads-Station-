import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

// A ready request must retain its issue identity when activated; non-ready
// requests remain inert. Execution is owned by DesignerShell after selection.

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

describe('BeadGraph request selection', () => {

  it('clicking a READY node passes the concrete issue to the designer flow', () => {
    const onSelect = vi.fn()
    render(<BeadGraph onSelect={onSelect} />)
    const node = document.querySelector('[data-bs-bead-node="Code-ready"]') as HTMLElement
    expect(node).toBeTruthy()
    expect(node.getAttribute('data-bs-bead-state')).toBe('ready')
    node.click()
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'Code-ready', title: 'Ready bead' }))
  })

  it('clicking a BLOCKED node is inert (no spawn)', () => {
    const onSelect = vi.fn()
    render(<BeadGraph onSelect={onSelect} />)
    const node = document.querySelector('[data-bs-bead-node="Code-blocked"]') as HTMLElement
    expect(node).toBeTruthy()
    expect(node.getAttribute('data-bs-bead-state')).toBe('blocked')
    node.click()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('renders the state locator attr on every node', () => {
    render(<BeadGraph />)
    expect(screen.getByText('Ready bead')).toBeTruthy()
    expect(document.querySelectorAll('[data-bs-bead-node]').length).toBe(2)
  })
})
