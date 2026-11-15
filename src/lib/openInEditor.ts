// Open a file in the user's editor (Settings → Sessions → Editor command,
// nvim by default) from a Command+click in a terminal, the Explorer, History
// or the Designer's changed-files list.
//
// A vi-like editor already in the foreground of a pane in this tab is reused
// with `:edit`; the foreground program is checked first, so nothing is ever
// typed into a shell or an agent by mistake. Otherwise the file opens in a new
// split whose shell runs the editor.

import { invoke } from '@tauri-apps/api/core'
import { activeTabRoot, focusPane, launchInTerminalPane, leavesOf, typeIntoActiveShell } from '../state/termPanes'
import { editorCommand } from '../state/sessionPreferences'
import { setFocused } from '../state/vim'
import { setSkin } from '../state/skin'
import { editorOpenCommand, isViEditor, isViProgram, resolveLinkedPath, viEditKeys } from './terminalLinks'

interface Foreground { program?: string | null; cwd?: string | null }

function foreground(ptyId: number): Promise<Foreground | null> {
  return invoke<Foreground | null>('pty_foreground', { id: ptyId, wantSession: false }).catch(() => null)
}

export interface EditorTarget { path: string; line?: number | null; col?: number | null }
export interface EditorSource {
  /** The terminal the path was printed in: its foreground folder resolves a relative path. */
  ptyId?: number | null
  /** Folder to fall back on (the pane's or workspace's). */
  cwd?: string | null
}

/** Returns what happened, for a hint line: 'reused', 'opened', or null when the path cannot be resolved. */
export async function openInEditor(target: EditorTarget, source: EditorSource = {}): Promise<'reused' | 'opened' | null> {
  let cwd = source.cwd ?? null
  const relative = !target.path.startsWith('/') && !target.path.startsWith('~')
  if (relative && source.ptyId != null) cwd = (await foreground(source.ptyId))?.cwd || cwd
  const path = resolveLinkedPath(target.path, cwd)
  if (!path) return null
  const editor = editorCommand()
  const line = target.line ?? null
  const col = target.col ?? null

  const show = () => { setSkin('terminal'); setFocused('terminal'); typeIntoActiveShell() }

  if (isViEditor(editor)) {
    const shells = leavesOf(activeTabRoot()).filter(leaf => leaf.ptyId != null && !leaf.restored && !leaf.agent && !leaf.fileNav && !leaf.browser)
    const programs = await Promise.all(shells.map(leaf => foreground(leaf.ptyId!)))
    const index = programs.findIndex(found => isViProgram(found?.program))
    if (index >= 0) {
      const pane = shells[index]
      try {
        await invoke('pty_write', { id: pane.ptyId, data: viEditKeys(path, line, col) })
        focusPane(pane.paneId)
        show()
        return 'reused'
      } catch { /* that editor went away: open a new one below */ }
    }
  }
  launchInTerminalPane(editorOpenCommand(editor, path, line, col))
  show()
  return 'opened'
}
