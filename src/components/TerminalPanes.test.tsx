import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import { setSessionPreferences } from '../state/sessionPreferences'
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
    expect(document.querySelectorAll('[data-restored-pane]')).toHaveLength(1)
    expect(document.querySelector('[data-terminal-pane="pane911"]')).toBeNull()
    expect(document.querySelector('[data-terminal-pane="pane913"]')).not.toBeNull()
    expect(screen.getAllByRole('button', { name: 'New shell' })).toHaveLength(1)
    const resume = screen.getByRole('button', { name: 'Continue Codex' })
    // The pane knew its Codex session, so that exact one is reopened.
    expect(resume).toHaveAttribute('title', expect.stringContaining('codex resume 01a12f2b-69d8-7ea0-a23b-0fd1d81cac0e'))
    expect(screen.getByText(/Continues this exact conversation/)).toBeInTheDocument()
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'pty_spawn')).toBe(false)

    // Enter in the message box is the same explicit action as the button, and carries the message.
    const box = screen.getByLabelText('Message Codex to continue')
    act(() => { fireEvent.change(box, { target: { value: "what's left?" } }) })
    act(() => { fireEvent.submit(box.closest('form')!) })

    expect(document.querySelector('[data-terminal-pane="pane911"]')).not.toBeNull()
    expect(takePaneStartupCommand('pane911')).toBe("codex resume 01a12f2b-69d8-7ea0-a23b-0fd1d81cac0e -c tui.notifications=true -c tui.notification_method=osc9 'what'\\''s left?'")
    expect(takePaneStartupCommand('pane913')).toBeNull()
  })

  it('shows the likely conversation for a pane that never learned its session, and continues exactly that one', async () => {
    const id = 'aaaa1111-0000-4000-8000-000000000001'
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'transcripts_list') return [{ id, provider: 'claude', title: 't', firstPrompt: 'p', modifiedMs: 5_000_000_000, bytes: 1 }]
      if (command === 'transcript_read') return { id, provider: 'claude', truncated: false, usage: null, turns: [{ role: 'user', at: null, blocks: [{ kind: 'text', text: 'Fix the header spacing' }], files: [], thinking: 0 }] }
      return null
    })
    restoreProjects(JSON.stringify({ v: 2, projects: { 'restore-guess': {
      tabs: [{ id: 'tab920', activePaneId: 'pane921', root: { kind: 'leaf', paneId: 'pane921', ptyId: 4, cwd: '/tmp/restore', agentCli: 'claude', savedScreen: { lines: ['> hi'], cols: 80, rows: 24, buffer: 'normal', cursorX: 0, cursorY: 0, capturedAt: 5_000_060_000 } } }],
      activeTabId: 'tab920', insert: false,
    } } }))
    setActiveProject('restore-guess', '/tmp/restore')

    render(<TerminalPanes termFocused />)

    expect(await screen.findByText('Fix the header spacing')).toBeInTheDocument()
    expect(screen.getByText(/Most recent Claude conversation in this folder/)).toBeInTheDocument()
    // Reading is not starting: no shell, no provider.
    expect(document.querySelector('[data-terminal-pane="pane921"]')).toBeNull()
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Continue Claude' })) })
    expect(takePaneStartupCommand('pane921')).toContain(`--resume ${id}`)
  })

  it('reopens a known conversation by itself only when the setting is on', async () => {
    const id = 'bbbb2222-0000-4000-8000-000000000002'
    mocks.invoke.mockImplementation(async () => null)
    const saved = (project: string, pane: string) => JSON.stringify({ v: 2, projects: { [project]: {
      tabs: [{ id: `tab-${pane}`, activePaneId: pane, root: { kind: 'leaf', paneId: pane, ptyId: 4, cwd: '/tmp/restore', agentCli: 'claude', agentSessionId: id } }],
      activeTabId: `tab-${pane}`, insert: false,
    } } })
    restoreProjects(saved('restore-manual', 'pane931'))
    setActiveProject('restore-manual', '/tmp/restore')
    const first = render(<TerminalPanes termFocused />)
    expect(document.querySelector('[data-terminal-pane="pane931"]')).toBeNull()
    first.unmount()

    setSessionPreferences({ autoResumeAgents: true })
    try {
      restoreProjects(saved('restore-auto', 'pane941'))
      setActiveProject('restore-auto', '/tmp/restore')
      render(<TerminalPanes termFocused />)
      await waitFor(() => expect(document.querySelector('[data-terminal-pane="pane941"]')).not.toBeNull())
      expect(takePaneStartupCommand('pane941')).toContain(`--resume ${id}`)
    } finally {
      setSessionPreferences({ autoResumeAgents: false })
    }
  })
})
