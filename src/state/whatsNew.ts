// "What's new" after an update. The notes are short and written for the
// person using the app; the full text lives in docs/releases/.

import appPackage from '../../package.json'
import { persistDurableUserConfigKey } from '../lib/durableUserConfig'

export const LAST_SEEN_VERSION_KEY = 'beads-station.last-seen-version'

export const RELEASE_HIGHLIGHTS: Record<string, readonly string[]> = {
  '0.2.0': [
    'Designer → History: every Claude Code and Codex session in a folder, read as a formatted conversation. No resume needed, no tokens used, and it works after a restart.',
    'Resume in Session starts the CLI on exactly the conversation you were reading. A ticket lists the sessions that worked on it.',
    'Designer → Shelf: pin text, a file or a markdown note (an Obsidian note works) and type it into any running agent. It never presses Enter.',
    'A quiet usage meter: Codex 5-hour and weekly limits against an even pace, and Claude output tokens for the week. Read from the CLIs’ own files.',
    'After a restart, a pane that ran Claude or Codex shows that conversation read-only. Session usage appears for both CLIs, in History and on a live agent pane.',
    'Restore split undoes Unsplit. Cmd+click a link opens the browser in a new tab, and Cmd+click a markdown path opens its folder.',
    'Native File, View, Window, Help and Agents menus, and a Finder right-click action: Open Folder in Beads Station.',
  ],
  '0.1.7': [
    'Far fewer crashes: one bad event no longer takes the whole app and its terminals down. Settings → About lists anything it recovered from.',
    'A program that floods its terminal now slows down instead of filling memory, and a blank web page reloads itself.',
    'Designer: Requests is a board, and the Bead map groups beads into epics with real blocker arrows. Click to inspect, double-click to open any bead.',
    'New shortcuts without Option: Cmd Shift arrows move between panes and take the cursor with them, Cmd 1–9 picks a workspace, Cmd [ and ] step through them, Cmd Shift W closes one. Control Shift 1–9 picks a terminal tab.',
    'Start Claude chat now opens the real CLI in a terminal pane. Settings → Sessions sets the command, for example claude --dangerously-skip-permissions.',
    'Dropped files land in the pane under the pointer. Tabs and workspaces can be dragged to reorder.',
    'Chats and browser panes have a close button, and Join tabs undoes Unsplit.',
    'Dragging a split no longer sticks to the cursor over a browser pane. Cmd+click a link opens it in the browser pane, and sites that refuse to appear there say so.',
    'Open workspace can clone a git repository. The 16-terminal limit is gone.',
  ],
  '0.1.6': [
    'Terminal rows no longer hide under the status bar in the Terminal only view.',
    'Switching terminal tabs or panes puts the cursor in the shell. A plain shell starts again by itself after a restart.',
    'Selecting text in a terminal copies it. Hold Option while dragging to select inside Claude Code, Codex or Neovim.',
    'Cmd + and Cmd - change the terminal text size. Shortcuts can use Tab, and Control+letter keys reach the shell again.',
    'Cmd I lists every pane that is waiting for you. Settings → Notifications can also post to macOS Notification Center.',
    'Claude Code can tell a pane exactly when it needs you, and a restart reopens the exact conversation a pane had (Settings → Notifications → Exact signals).',
    'Cmd Shift L opens a browser pane beside the terminal. Local links printed by a dev server open there.',
    'Designer → Session runs the real Claude Code or Codex CLI next to the files it changed, and can capture, approve and close a ticket.',
    'Designer runs can use the Opus conductor, and show what delegated workers are doing.',
    'Updates can install themselves: Settings → About → Install, then Restart to update.',
    'Optional: Settings → Sessions → Keep terminals running when Beads Station quits.',
    'Open a folder from Finder with Open With, or drop it on the Dock icon.',
  ],
}

function compare(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] || 0) - (right[index] || 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Highlights of every release newer than the one last seen, newest first.
 * Empty on a first install: there is nothing "new" to someone who just arrived.
 */
export function unseenHighlights(
  current: string = appPackage.version,
  storage: Pick<Storage, 'getItem' | 'length'> = localStorage,
): { version: string; items: readonly string[] }[] {
  let seen: string | null = null
  try { seen = storage.getItem(LAST_SEEN_VERSION_KEY) } catch { return [] }
  // 0.1.5 and earlier never wrote this key; other saved settings mark an upgrade.
  if (seen === null) {
    if (storage.length === 0) return []
    seen = '0.1.5'
  }
  const from = seen
  return Object.keys(RELEASE_HIGHLIGHTS)
    .filter(version => compare(version, from) > 0 && compare(version, current) <= 0)
    .sort((a, b) => compare(b, a))
    .map(version => ({ version, items: RELEASE_HIGHLIGHTS[version] }))
}

export function markVersionSeen(current: string = appPackage.version): void {
  try { localStorage.setItem(LAST_SEEN_VERSION_KEY, current) } catch { /* optional storage */ }
  persistDurableUserConfigKey(LAST_SEEN_VERSION_KEY)
}
