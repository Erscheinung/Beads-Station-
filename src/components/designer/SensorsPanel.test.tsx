import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

// RV5.1 (Code-qqa) — SensorsPanel render + promote/dismiss wiring. Mocks the
// bridge seam and the projects store so the panel mounts with one wisp; asserts
// the card renders (title + source) and that Promote/Dismiss call the right
// bridge fn with (repoPath, id).

const senseList = vi.fn()
const sensePromote = vi.fn((_repo: string, _id: string) => Promise.resolve())
const senseDismiss = vi.fn((_repo: string, _id: string) => Promise.resolve())
const senseScan = vi.fn(() => Promise.resolve(0))

vi.mock('../../lib/senseBridge', () => ({
  senseList: () => senseList(),
  sensePromote: (repo: string, id: string) => sensePromote(repo, id),
  senseDismiss: (repo: string, id: string) => senseDismiss(repo, id),
  senseScan: () => senseScan(),
  senseWatchStart: () => Promise.resolve(),
  senseWatchStop: () => Promise.resolve(),
}))

vi.mock('../../lib/safeListen', () => ({
  safeListen: () => Promise.resolve(),
}))

const REPO = '/repo/a'
vi.mock('../../state/projects', () => ({
  useProjects: () => ({ projects: [{ id: 'p1', path: REPO }], activeId: 'p1' }),
}))

import { SensorsPanel } from './SensorsPanel'

const WISP = {
  id: 'Code-wisp-abc',
  title: 'rv51-smoke',
  description: null,
  status: 'open',
  created_at: '2026-08-12T16:30:00Z',
  source: 'Implementation Prompts/rv51-smoke.md',
}

describe('SensorsPanel', () => {
  beforeEach(() => {
    senseList.mockReset().mockResolvedValue([WISP])
    sensePromote.mockClear()
    senseDismiss.mockClear()
    senseScan.mockClear().mockResolvedValue(0)
  })

  it('renders a sensed wisp card with title + source', async () => {
    render(<SensorsPanel />)
    expect(await screen.findByText('rv51-smoke')).toBeInTheDocument()
    expect(screen.getByText('Implementation Prompts/rv51-smoke.md')).toBeInTheDocument()
    expect(screen.getByText('Code-wisp-abc')).toBeInTheDocument()
  })

  it('Promote calls sensePromote(repo, id)', async () => {
    render(<SensorsPanel />)
    const btn = await screen.findByRole('button', { name: 'Promote' })
    fireEvent.click(btn)
    await waitFor(() => expect(sensePromote).toHaveBeenCalledWith(REPO, 'Code-wisp-abc'))
  })

  it('Dismiss calls senseDismiss(repo, id)', async () => {
    render(<SensorsPanel />)
    const btn = await screen.findByRole('button', { name: 'Dismiss' })
    fireEvent.click(btn)
    await waitFor(() => expect(senseDismiss).toHaveBeenCalledWith(REPO, 'Code-wisp-abc'))
  })

  it('empty result shows the idle line', async () => {
    senseList.mockResolvedValue([])
    render(<SensorsPanel />)
    expect(await screen.findByText('No sensed files awaiting a decision.')).toBeInTheDocument()
  })
})
