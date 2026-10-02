import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./claudeStatus', () => ({ getClaudeStatus: () => 'idle', subscribeClaudeStatus: () => () => {} }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setBadgeCount: vi.fn(async () => {}) }) }))

import { activeTerminalTabId, activeTabRoot, leavesOf, locatePane, newTab, setActiveProject, splitActive, switchTab, focusPane } from './termPanes'
import { __resetPaneNotificationsForTest, clearAllPaneNotifications, getPaneNotifications, jumpToLatestPaneNotification, notifiedWorkspaceIds, notifyPane } from './paneNotifications'
import { setNotificationPreferences } from './notificationPreferences'
import { setSkin } from './skin'

let workspace = 0
let focused = true

/** A fresh workspace with two side-by-side panes; the second one is selected. */
function twoPanes(): { id: string; first: string; second: string } {
  const id = `notify-ws-${++workspace}`
  setActiveProject(id, `/repo/${id}`)
  splitActive('v')
  const [first, second] = leavesOf(activeTabRoot()).map(leaf => leaf.paneId)
  return { id, first, second }
}

beforeEach(() => {
  focused = true
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  setSkin('terminal')
  setNotificationPreferences({ enabled: true, notifyOnQuiet: true, autoSwitch: false, dockBadge: true })
  __resetPaneNotificationsForTest()
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('pane notifications', () => {
  it('marks a pane the user is not looking at and never the one they are', () => {
    const { first, second } = twoPanes()
    notifyPane(second, 'bell')
    expect(getPaneNotifications().size).toBe(0)
    notifyPane(first, 'osc', '  Build finished  ')
    expect(getPaneNotifications().get(first)).toMatchObject({ source: 'osc', message: 'Build finished' })
  })
  it('treats the selected pane as unattended while the window is in the background', () => {
    const { second } = twoPanes()
    focused = false
    notifyPane(second, 'quiet')
    expect(getPaneNotifications().get(second)?.message).toBe('Finished working')
    focused = true
    window.dispatchEvent(new Event('focus'))
    expect(getPaneNotifications().size).toBe(0)
  })
  it('clears a mark when its pane is focused and when the pane is gone', () => {
    const { first } = twoPanes()
    notifyPane(first, 'bell')
    notifyPane('no-such-pane', 'bell')
    expect([...getPaneNotifications().keys()]).toEqual([first])
    focusPane(first)
    expect(getPaneNotifications().size).toBe(0)
  })
  it('marks hidden terminal tabs and other workspaces, and jumps to the latest one', () => {
    const a = twoPanes()
    newTab()
    const hiddenTabPane = a.first
    notifyPane(hiddenTabPane, 'bell')
    const b = twoPanes()
    expect(notifiedWorkspaceIds()).toEqual(new Set([a.id]))
    notifyPane(b.first, 'osc', 'later')

    const activate = vi.fn()
    window.addEventListener('workspace:activate', activate)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000)
    notifyPane(hiddenTabPane, 'agent')
    expect(jumpToLatestPaneNotification()).toBe(true)
    window.removeEventListener('workspace:activate', activate)
    expect((activate.mock.calls[0][0] as CustomEvent).detail).toEqual({ id: a.id })

    // The app answers that event by activating the workspace; the pane store
    // then selects the pane's tab and the pane itself.
    setActiveProject(a.id, `/repo/${a.id}`)
    expect(locatePane(hiddenTabPane)).toMatchObject({ projectId: a.id, active: true })
    expect(locatePane(hiddenTabPane)?.tabId).toBe(activeTerminalTabId())
    expect(getPaneNotifications().has(hiddenTabPane)).toBe(false)
    expect(getPaneNotifications().has(b.first)).toBe(true)
  })
  it('honours the preferences: off, quiet-off, and clear all', () => {
    const { first } = twoPanes()
    setNotificationPreferences({ notifyOnQuiet: false })
    notifyPane(first, 'quiet')
    expect(getPaneNotifications().size).toBe(0)
    notifyPane(first, 'bell')
    expect(getPaneNotifications().size).toBe(1)
    setNotificationPreferences({ enabled: false })
    expect(getPaneNotifications().size).toBe(0)
    notifyPane(first, 'bell')
    expect(getPaneNotifications().size).toBe(0)
    setNotificationPreferences({ enabled: true })
    notifyPane(first, 'bell')
    clearAllPaneNotifications()
    expect(getPaneNotifications().size).toBe(0)
  })
  it('auto-switches only after typing has paused and dialogs are closed', () => {
    vi.useFakeTimers()
    let now = 50_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const { first } = twoPanes()
    newTab()
    setNotificationPreferences({ autoSwitch: true })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    notifyPane(first, 'bell')
    expect(locatePane(first)?.active).toBe(false)
    now += 1000; vi.advanceTimersByTime(1000)
    expect(locatePane(first)?.active).toBe(false)

    const dialog = document.body.appendChild(document.createElement('div'))
    dialog.setAttribute('role', 'dialog')
    now += 1000; vi.advanceTimersByTime(1000)
    expect(locatePane(first)?.active).toBe(false)
    dialog.remove()

    now += 600; vi.advanceTimersByTime(600)
    expect(locatePane(first)?.active).toBe(true)
    expect(getPaneNotifications().size).toBe(0)
    switchTab(0)
  })
})
