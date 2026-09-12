import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  openFolder: vi.fn(),
  refresh: vi.fn(),
  saveRoots: vi.fn(),
}))

vi.mock('../state/projects', () => ({
  useProjects: () => ({
    availableProjects: [
      { id: 'beads', name: 'Beads Station', path: '/tmp/beads-station', hasGit: true, hasBeads: true, claudeSessionId: '' },
      { id: 'nexus', name: 'Nexus', path: '/tmp/nexus', hasGit: true, hasBeads: false, claudeSessionId: '' },
    ],
    openIds: [],
    roots: ['/tmp'],
    warnings: [],
    loaded: true,
    error: null,
    openFolder: mocks.openFolder,
    refresh: mocks.refresh,
    saveRoots: mocks.saveRoots,
  }),
}))

import { WorkspacePicker } from './WorkspacePicker'

describe('WorkspacePicker typeahead', () => {
  beforeEach(() => {
    mocks.openFolder.mockReset().mockResolvedValue(undefined)
    mocks.refresh.mockReset()
    mocks.saveRoots.mockReset()
  })

  it('filters from the prominent field and Enter opens the best discovered project', async () => {
    render(<WorkspacePicker />)
    const folder = screen.getByLabelText('Folder path')
    const search = screen.getByLabelText('Search projects')

    fireEvent.change(folder, { target: { value: 'Nex' } })

    expect(search).toHaveValue('Nex')
    expect(document.querySelectorAll('.workspace-picker__project')).toHaveLength(1)
    expect(document.querySelector('.workspace-picker__project')).toHaveTextContent('Nexus')
    expect(document.querySelector('.workspace-picker__project')).not.toHaveTextContent('Beads Station')
    expect(screen.getByRole('button', { name: 'Open Nexus' })).toBeEnabled()

    fireEvent.submit(folder.closest('form')!)
    await waitFor(() => expect(mocks.openFolder).toHaveBeenCalledWith('/tmp/nexus'))
  })

  it('keeps an explicit path on the direct open-folder path without refreshing discovery', async () => {
    render(<WorkspacePicker />)
    const folder = screen.getByLabelText('Folder path')

    fireEvent.change(folder, { target: { value: '/tmp/new-folder' } })
    expect(screen.getByLabelText('Search projects')).toHaveValue('')
    expect(screen.getByRole('button', { name: /Open folder/ })).toBeEnabled()

    fireEvent.submit(folder.closest('form')!)
    await waitFor(() => expect(mocks.openFolder).toHaveBeenCalledWith('/tmp/new-folder'))
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('shows a no-match state and does not submit an arbitrary project name', () => {
    render(<WorkspacePicker />)
    const folder = screen.getByLabelText('Folder path')

    fireEvent.change(folder, { target: { value: 'unknown-project' } })

    expect(screen.getByText('No matching projects.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /No matching project/ })).toBeDisabled()
    fireEvent.submit(folder.closest('form')!)
    expect(mocks.openFolder).not.toHaveBeenCalled()
  })
})
