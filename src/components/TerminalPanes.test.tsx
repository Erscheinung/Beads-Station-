import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  setFocused: vi.fn(),
  ClaudeChat: vi.fn(() => null),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../state/vim', () => ({ setFocused: mocks.setFocused }))
vi.mock('../state/claudeStatus', () => ({ useClaudeStatus: () => 'idle', getClaudeStatus: () => 'idle', subscribeClaudeStatus: () => () => {} }))
vi.mock('./Terminal', () => ({
  Terminal: ({ paneId }: { paneId: string }) => <div data-terminal-pane={paneId} />,
}))
vi.mock('./ClaudeChat', () => ({ ClaudeChat: mocks.ClaudeChat }))
vi.mock('./FileTree', () => ({ FileTree: () => <div data-file-tree /> }))

import { TerminalPanes } from './TerminalPanes'
import {
  activeTabRoot,
  leavesOf,
  registerPty,
  restoreProjects,
  setActiveProject,
  splitActive,
  takePaneStartupCommand,
} from '../state/termPanes'

describe('TerminalPanes tab accessibility', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.setFocused.mockReset()
    mocks.ClaudeChat.mockClear()
  })

  it('names each tab, tracks selection, and keeps its PTY when switching', () => {
    // Start with two mounted panes so each tab already owns a shell handle
    // when unsplitToTabs converts them into separate tabs.
    splitActive('v')
    const paneIds = leavesOf(activeTabRoot()).map(leaf => leaf.paneId)
    const ptyByPane = new Map(paneIds.map((paneId, index) => [paneId, 700 + index]))
    for (const [paneId, ptyId] of ptyByPane) registerPty(paneId, ptyId)

    render(<TerminalPanes termFocused />)
    fireEvent.click(screen.getByRole('button', { name: 'Unsplit to tabs' }))

    const tablist = screen.getByRole('tablist', { name: 'Terminal tabs' })
    const tabs = within(tablist).getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]).toHaveAccessibleName('Terminal tab 1: shell')
    expect(tabs[1]).toHaveAccessibleName('Terminal tab 2: shell')
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false')

    const firstTabPane = leavesOf(activeTabRoot())[0]
    const secondTabPaneId = paneIds.find(paneId => paneId !== firstTabPane.paneId)!
    expect(firstTabPane.ptyId).toBe(ptyByPane.get(firstTabPane.paneId))

    act(() => fireEvent.click(tabs[1]))

    expect(tabs[0]).toHaveAttribute('aria-selected', 'false')
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    const switchedPane = leavesOf(activeTabRoot())[0]
    expect(switchedPane.paneId).toBe(secondTabPaneId)
    expect(switchedPane.ptyId).toBe(ptyByPane.get(secondTabPaneId))
    expect(mocks.invoke).not.toHaveBeenCalledWith('pty_spawn', expect.anything())
  })

  it('renders restored provider context without mounting a provider adapter', () => {
    restoreProjects(JSON.stringify({
      v: 2,
      projects: {
        'restore-no-turn': {
          tabs: [{
            id: 'tab900',
            activePaneId: 'pane901',
            root: {
              kind: 'leaf', paneId: 'pane901', ptyId: 88, cwd: '/tmp/restore',
              agent: { bridgeId: 'agent902', projectId: 'restore-no-turn', sessionId: 'allocation', provider: 'claude', configurationId: 'native:claude:plan', permissionMode: 'plan' },
            },
          }],
          activeTabId: 'tab900',
          insert: true,
        },
      },
    }))
    setActiveProject('restore-no-turn', '/tmp/restore')
    localStorage.setItem('bs.claude.session:agent902', 'stale-provider-id')

    render(<TerminalPanes termFocused />)

    expect(screen.getByText('Saved Claude session')).toBeInTheDocument()
    expect(screen.getByText(/stale-provider-id/)).toBeInTheDocument()
    expect(screen.getByText(/No live process is attached and no model turn was started/)).toBeInTheDocument()
    expect(mocks.ClaudeChat).not.toHaveBeenCalled()
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'claude_start' || command === 'codex_chat_start' || command === 'codex_chat_send')).toBe(false)
  })

  it('restarts a plain restored shell, and resumes an agent CLI only when asked', () => {
    restoreProjects(JSON.stringify({
      v: 2,
      projects: {
        'restore-cli': {
          tabs: [{
            id: 'tab910',
            activePaneId: 'pane911',
            root: {
              kind: 'split', splitId: 'split912', dir: 'v', ratio: 0.5,
              a: { kind: 'leaf', paneId: 'pane911', ptyId: 4, cwd: '/tmp/restore', agentCli: 'codex', agentSessionId: '01a12f2b-69d8-7ea0-a23b-0fd1d81cac0e', savedScreen: { lines: ['codex> hi'], cols: 80, rows: 24, buffer: 'normal', cursorX: 0, cursorY: 0, capturedAt: 1 } },
              b: { kind: 'leaf', paneId: 'pane913', ptyId: 5, cwd: '/tmp/restore' },
            },
          }],
          activeTabId: 'tab910',
          insert: false,
        },
      },
    }))
    setActiveProject('restore-cli', '/tmp/restore')

    render(<TerminalPanes termFocused />)

    // The pane that ran an agent CLI waits for the user; the plain shell just starts.
    expect(screen.getAllByText(/previous shell is stopped/)).toHaveLength(1)
    expect(document.querySelector('[data-terminal-pane="pane911"]')).toBeNull()
    expect(document.querySelector('[data-terminal-pane="pane913"]')).not.toBeNull()
    expect(screen.getAllByRole('button', { name: 'Start new shell' })).toHaveLength(1)
    const resume = screen.getByRole('button', { name: 'Start shell and resume Codex' })
    // The pane knew its Codex session, so that exact one is reopened.
    expect(resume).toHaveAttribute('title', expect.stringContaining('codex resume 01a12f2b-69d8-7ea0-a23b-0fd1d81cac0e'))
    expect(screen.getByText(/Reopens this exact conversation/)).toBeInTheDocument()

    act(() => fireEvent.click(resume))

    expect(document.querySelector('[data-terminal-pane="pane911"]')).not.toBeNull()
    expect(takePaneStartupCommand('pane911')).toBe('codex resume 01a12f2b-69d8-7ea0-a23b-0fd1d81cac0e -c tui.notifications=true -c tui.notification_method=osc9')
    expect(takePaneStartupCommand('pane913')).toBeNull()
  })
})
