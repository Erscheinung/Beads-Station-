import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  openFolder: vi.fn(),
  refresh: vi.fn(),
  saveRoots: vi.fn(),
  browseForFolder: vi.fn(),
  discoverUnderFolder: vi.fn(),
  cancelFolderDiscovery: vi.fn(),
}))

const projects = [
  { id: 'beads', name: 'Beads Station', path: '/tmp/beads-station', hasGit: true, hasBeads: true, claudeSessionId: '' },
  { id: 'nexus', name: 'Nexus', path: '/tmp/nexus', hasGit: true, hasBeads: false, claudeSessionId: '' },
  { id: 'nexus-two', name: 'Nexus', path: '/tmp/a folder/nexus', hasGit: false, hasBeads: false, claudeSessionId: '' },
]

vi.mock('../state/projects', () => ({
  useProjects: () => ({
    availableProjects: projects,
    openIds: [],
    recentIds: ['nexus', 'beads'],
    roots: ['/tmp'],
    warnings: [],
    loaded: true,
    error: null,
    openFolder: mocks.openFolder,
    refresh: mocks.refresh,
    saveRoots: mocks.saveRoots,
  }),
  browseForFolder: mocks.browseForFolder,
  discoverUnderFolder: mocks.discoverUnderFolder,
  cancelFolderDiscovery: mocks.cancelFolderDiscovery,
}))

import { WorkspacePicker } from './WorkspacePicker'

describe('WorkspacePicker A4 finder', () => {
  beforeEach(() => {
    mocks.openFolder.mockReset().mockResolvedValue(undefined)
    mocks.refresh.mockReset()
    mocks.saveRoots.mockReset()
    mocks.browseForFolder.mockReset().mockResolvedValue(null)
    mocks.discoverUnderFolder.mockReset().mockResolvedValue({ projects, roots: ['/tmp'], warnings: [], truncated: false })
    mocks.cancelFolderDiscovery.mockReset().mockResolvedValue(undefined)
  })

  it('shows recent explicit opens before other known projects for an empty query', () => {
    render(<WorkspacePicker />)
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
      expect.stringContaining('Nexus'),
      expect.stringContaining('Beads Station'),
      expect.stringContaining('/tmp/a folder/nexus'),
    ])
  })

  it('ranks exact, prefix and fuzzy matches from the cached list', () => {
    render(<WorkspacePicker />)
    const entry = screen.getByRole('combobox')
    fireEvent.change(entry, { target: { value: 'Nex' } })
    expect(screen.getAllByRole('option')).toHaveLength(2)
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('/tmp/nexus')
    fireEvent.change(entry, { target: { value: 'bds sta' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option')).toHaveTextContent('Beads Station')
  })

  it('moves the highlight with arrows and Enter opens the highlighted project', async () => {
    render(<WorkspacePicker />)
    const entry = screen.getByRole('combobox')
    fireEvent.keyDown(entry, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(entry, { key: 'Enter' })
    await waitFor(() => expect(mocks.openFolder).toHaveBeenCalledWith('/tmp/beads-station'))
  })

  it('opens an explicit path, including spaces and Unicode, without refreshing discovery', async () => {
    render(<WorkspacePicker />)
    const entry = screen.getByRole('combobox')
    fireEvent.change(entry, { target: { value: '/tmp/a folder/café-日本語' } })
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(screen.getByRole('button', { name: /Open folder/ })).toBeEnabled()
    fireEvent.keyDown(entry, { key: 'Enter' })
    await waitFor(() => expect(mocks.openFolder).toHaveBeenCalledWith('/tmp/a folder/café-日本語'))
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('keeps a no-match query from opening an arbitrary name', () => {
    render(<WorkspacePicker />)
    const entry = screen.getByRole('combobox')
    fireEvent.change(entry, { target: { value: 'unknown-project' } })
    expect(screen.getByText('No matching projects.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /No matching project/ })).toBeDisabled()
    fireEvent.keyDown(entry, { key: 'Enter' })
    expect(mocks.openFolder).not.toHaveBeenCalled()
  })

  it('uses one entry field and switches to a bounded Under folder index explicitly', async () => {
    render(<WorkspacePicker />)
    expect(screen.queryByLabelText('Search projects')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Under folder' }))
    await waitFor(() => expect(mocks.discoverUnderFolder).toHaveBeenCalledWith('/tmp', expect.any(String)))
    expect(screen.getByRole('listbox', { name: 'Projects under folder' })).toBeInTheDocument()
  })

  it('leaves the path unchanged when Browse is cancelled and uses the selected path when opened', async () => {
    render(<WorkspacePicker />)
    const entry = screen.getByRole('combobox')
    fireEvent.change(entry, { target: { value: 'Nex' } })
    fireEvent.click(screen.getByRole('button', { name: 'Browse for a workspace folder' }))
    await waitFor(() => expect(mocks.browseForFolder).toHaveBeenCalledTimes(1))
    expect(entry).toHaveValue('Nex')
    mocks.browseForFolder.mockResolvedValueOnce('/tmp/a folder')
    fireEvent.click(screen.getByRole('button', { name: 'Browse for a workspace folder' }))
    await waitFor(() => expect(entry).toHaveValue('/tmp/a folder'))
  })
})
