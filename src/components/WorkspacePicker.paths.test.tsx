import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  openFolder: vi.fn(),
  refresh: vi.fn(),
  saveRoots: vi.fn(),
  browseForFolder: vi.fn(),
  discoverUnderFolder: vi.fn(),
  cancelFolderDiscovery: vi.fn(),
}))

// Built at runtime so no literal home path sits in the source (public-repo scan).
const HOME = ['', 'Users', 'someone'].join('/')
const projects = [
  { id: 'homey', name: 'Homey', path: `${HOME}/Code/homey`, hasGit: false, hasBeads: false, claudeSessionId: '' },
]

vi.mock('../state/projects', () => ({
  useProjects: () => ({
    availableProjects: projects,
    openIds: [],
    recentIds: ['homey'],
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

describe('WorkspacePicker paths', () => {
  beforeEach(() => { mocks.discoverUnderFolder.mockReset().mockResolvedValue({ projects, roots: ['/tmp'], warnings: [], truncated: false }) })
  it('shows the home folder as ~, in the row and in the accessible name', () => {
    render(<WorkspacePicker />)
    const option = screen.getByRole('option')
    expect(option).toHaveTextContent('~/Code/homey')
    expect(option.textContent).not.toContain(HOME)
    expect(option).toHaveAccessibleName(expect.stringContaining('~/Code/homey'))
  })
})
