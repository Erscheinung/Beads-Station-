// Pane notifications: which terminal or agent panes are waiting for the user.
//
// A pane notifies when it is not the one being looked at and something says
// "done" or "needs you": a terminal bell, an OSC 9/99/777 notification, an
// agent pane finishing a turn, or (optionally) a background terminal going
// quiet after sustained output. The mark stays until the pane is attended.
// Nothing here starts a process or a model turn.

import { useSyncExternalStore } from 'react'
import { allAgentBridges, locatePane, paneForAgentBridge, revealPane, subscribeTermPanes } from './termPanes'
import { getNotificationPreferences, subscribeNotificationPreferences } from './notificationPreferences'
import { getClaudeStatus, subscribeClaudeStatus, type ClaudeStatus } from './claudeStatus'
import { getSkin, setSkin, subscribeSkin } from './skin'
import { setFocused } from './vim'

export type PaneNotificationSource = 'bell' | 'osc' | 'quiet' | 'agent'

export interface PaneNotification {
  paneId: string
  source: PaneNotificationSource
  message: string
  at: number
}

const MESSAGE_LIMIT = 200
const DEFAULT_MESSAGE: Record<PaneNotificationSource, string> = {
  bell: 'Terminal bell',
  osc: 'Needs attention',
  quiet: 'Finished working',
  agent: 'Agent is waiting for you',
}

let notifications: ReadonlyMap<string, PaneNotification> = new Map()
const listeners = new Set<() => void>()

function emit(): void {
  listeners.forEach(listener => listener())
  syncDockBadge()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function getSnapshot(): ReadonlyMap<string, PaneNotification> {
  return notifications
}

export function usePaneNotifications(): ReadonlyMap<string, PaneNotification> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function getPaneNotifications(): ReadonlyMap<string, PaneNotification> {
  return notifications
}

/** The user is looking at this pane: selected, visible, and the window is focused. */
function isAttended(paneId: string): boolean {
  const location = locatePane(paneId)
  if (!location?.active) return false
  if (getSkin() !== 'terminal') return false
  return typeof document === 'undefined' || document.hasFocus()
}

export function notifyPane(paneId: string, source: PaneNotificationSource, message = ''): void {
  const preferences = getNotificationPreferences()
  if (!preferences.enabled) return
  if (source === 'quiet' && !preferences.notifyOnQuiet) return
  if (!locatePane(paneId) || isAttended(paneId)) return
  const text = (message.trim() || DEFAULT_MESSAGE[source]).slice(0, MESSAGE_LIMIT)
  const next = new Map(notifications)
  next.set(paneId, { paneId, source, message: text, at: Date.now() })
  notifications = next
  emit()
  if (preferences.autoSwitch) scheduleAutoSwitch(paneId)
}

export function clearPaneNotification(paneId: string): void {
  if (!notifications.has(paneId)) return
  const next = new Map(notifications)
  next.delete(paneId)
  notifications = next
  emit()
}

export function clearAllPaneNotifications(): void {
  if (notifications.size === 0) return
  notifications = new Map()
  emit()
}

/** Workspaces that contain at least one notifying pane. */
export function notifiedWorkspaceIds(current: ReadonlyMap<string, PaneNotification> = notifications): Set<string> {
  const ids = new Set<string>()
  for (const paneId of current.keys()) {
    const location = locatePane(paneId)
    if (location) ids.add(location.projectId)
  }
  return ids
}

export function latestPaneNotification(): PaneNotification | null {
  let latest: PaneNotification | null = null
  for (const notification of notifications.values()) {
    if (!latest || notification.at >= latest.at) latest = notification
  }
  return latest
}

/** Bring a pane to the front: its workspace, its tab, and keyboard focus. */
export function showPane(paneId: string): boolean {
  if (!locatePane(paneId)) return false
  setSkin('terminal')
  const workspaceId = revealPane(paneId)
  if (workspaceId !== null) window.dispatchEvent(new CustomEvent('workspace:activate', { detail: { id: workspaceId } }))
  setFocused('terminal')
  clearPaneNotification(paneId)
  return true
}

export function jumpToLatestPaneNotification(): boolean {
  const latest = latestPaneNotification()
  return latest ? showPane(latest.paneId) : false
}

// ---- attendance sweep ---------------------------------------------------

function sweep(): void {
  if (notifications.size === 0) return
  let next: Map<string, PaneNotification> | null = null
  for (const paneId of notifications.keys()) {
    if (locatePane(paneId) && !isAttended(paneId)) continue
    next ??= new Map(notifications)
    next.delete(paneId)
  }
  if (next) { notifications = next; emit() }
}

// ---- auto-switch --------------------------------------------------------
//
// Moving keyboard focus while the user is typing would send their keystrokes
// to another shell or agent, so the switch waits for a pause and for any open
// dialog to close.

const TYPING_PAUSE_MS = 1500
const AUTO_SWITCH_RETRY_MS = 500
const AUTO_SWITCH_MAX_TRIES = 60
let lastKeyAt = 0

function scheduleAutoSwitch(paneId: string, tries = 0): void {
  if (!notifications.has(paneId) || !getNotificationPreferences().autoSwitch) return
  const typing = performance.now() - lastKeyAt < TYPING_PAUSE_MS
  const dialogOpen = typeof document !== 'undefined' && document.querySelector('dialog[open], [role="dialog"]') !== null
  if (typing || dialogOpen) {
    if (tries < AUTO_SWITCH_MAX_TRIES) setTimeout(() => scheduleAutoSwitch(paneId, tries + 1), AUTO_SWITCH_RETRY_MS)
    return
  }
  showPane(paneId)
}

// ---- dock badge ---------------------------------------------------------

let badgeShown = 0
function syncDockBadge(): void {
  const count = getNotificationPreferences().dockBadge ? notifications.size : 0
  if (count === badgeShown) return
  badgeShown = count
  void import('@tauri-apps/api/window')
    .then(api => api.getCurrentWindow().setBadgeCount(count > 0 ? count : undefined))
    .catch(() => { /* browser harness or a platform without a badge */ })
}

// ---- agent panes --------------------------------------------------------
//
// Agent panes in hidden tabs and workspaces have no mounted view, so their
// status is watched here for as long as the pane exists.

const agentWatch = new Map<string, { status: ClaudeStatus; release: () => void }>()

function syncAgentWatch(): void {
  const live = new Set(allAgentBridges())
  for (const [bridgeId, watch] of agentWatch) {
    if (live.has(bridgeId)) continue
    watch.release()
    agentWatch.delete(bridgeId)
  }
  for (const bridgeId of live) {
    if (agentWatch.has(bridgeId)) continue
    const watch = { status: 'idle' as ClaudeStatus, release: () => {} }
    agentWatch.set(bridgeId, watch)
    watch.release = subscribeClaudeStatus(bridgeId, () => {
      const previous = watch.status
      watch.status = getClaudeStatus(bridgeId)
      if (previous !== 'running' || watch.status === 'running' || watch.status === 'idle') return
      const paneId = paneForAgentBridge(bridgeId)
      if (paneId) notifyPane(paneId, 'agent', watch.status === 'error' ? 'Agent reported an error' : '')
    })
    watch.status = getClaudeStatus(bridgeId)
  }
}

if (typeof window !== 'undefined') {
  // A failure here must never break the pane store that is notifying us.
  subscribeTermPanes(() => {
    try { sweep(); syncAgentWatch() } catch { /* status channel unavailable */ }
  })
  subscribeNotificationPreferences(() => {
    if (!getNotificationPreferences().enabled) clearAllPaneNotifications()
    syncDockBadge()
  })
  subscribeSkin(sweep)
  window.addEventListener('focus', sweep)
  window.addEventListener('keydown', () => { lastKeyAt = performance.now() }, true)
  try { syncAgentWatch() } catch { /* status channel unavailable */ }
}

export function __resetPaneNotificationsForTest(): void {
  notifications = new Map()
  lastKeyAt = 0
  badgeShown = 0
}
