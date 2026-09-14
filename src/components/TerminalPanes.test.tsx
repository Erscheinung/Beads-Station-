import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  setFocused: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../state/vim', () => ({ setFocused: mocks.setFocused }))
vi.mock('../state/claudeStatus', () => ({ useClaudeStatus: () => 'idle' }))
vi.mock('./Terminal', () => ({
  Terminal: ({ paneId }: { paneId: string }) => <div data-terminal-pane={paneId} />,
}))
vi.mock('./ClaudeChat', () => ({ ClaudeChat: () => <div data-agent-pane /> }))
vi.mock('./FileTree', () => ({ FileTree: () => <div data-file-tree /> }))

import { TerminalPanes } from './TerminalPanes'
import {
  activeTabRoot,
  leavesOf,
  registerPty,
  splitActive,
} from '../state/termPanes'

describe('TerminalPanes tab accessibility', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.setFocused.mockReset()
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
})
