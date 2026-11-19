// Native file drops onto a terminal pane (Code-da0.7).
//
// Tauri owns OS file drops on macOS: the DOM `drop` event never sees real
// paths, so listen to the webview's drag-drop events instead. The drop
// position is in physical pixels; convert it to CSS pixels to find the pane
// under the pointer, then paste shell-quoted paths into that session exactly
// like Terminal.app/iTerm do. Nothing is executed — the user still presses
// Enter.
//
// Despite the Physical type, wry reports macOS positions in points (it reads
// NSDraggingInfo.draggingLocation), so dividing there lands every drop in the
// left half of the window.

import { getCurrentWebview } from '@tauri-apps/api/webview'
import { invoke } from '@tauri-apps/api/core'
import { terminalSessionForNode } from './terminalSessions'

const TARGET_CLASS = 'bs-terminal-drop-target'

export function dropPoint(position: { x: number; y: number }, scale: number, mac: boolean) {
  return mac ? position : { x: position.x / scale, y: position.y / scale }
}

function sessionAt(position: { x: number; y: number }) {
  const { x, y } = dropPoint(position, window.devicePixelRatio || 1, /Mac/.test(navigator.platform))
  const node = document.elementFromPoint(x, y)
  return node ? terminalSessionForNode(node) : null
}

export type DropRoute = 'paste' | 'folder' | 'ignore'

/**
 * Where a drop goes. On a pane, paths are pasted as before; with Option held a
 * folder is brought in instead (Code-7xc.4). Elsewhere (tab bar, workspace
 * chrome) only a folder does anything: it opens a split there. Areas with a
 * drop target of their own (Pinned) are left to it.
 */
export function routeDrop(over: 'pane' | 'other' | 'own-target', optionHeld: boolean, hasFolder: boolean): DropRoute {
  if (over === 'own-target') return 'ignore'
  if (over === 'pane') return optionHeld && hasFolder ? 'folder' : 'paste'
  return hasFolder ? 'folder' : 'ignore'
}

async function optionHeldNow(): Promise<boolean> {
  try { return (await invoke<boolean>('external_option_held')) === true } catch { return false }
}

async function firstFolder(paths: string[]): Promise<string | null> {
  for (const path of paths) {
    try { if (await invoke<boolean>('external_path_is_dir', { path })) return path } catch { /* not a folder */ }
  }
  return null
}

export async function installTerminalFileDrop(): Promise<() => void> {
  let highlighted: HTMLElement | null = null
  const highlight = (element: HTMLElement | null) => {
    if (highlighted === element) return
    highlighted?.classList.remove(TARGET_CLASS)
    highlighted = element
    highlighted?.classList.add(TARGET_CLASS)
  }
  const unlisten = await getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type === 'leave') {
      highlight(null)
      return
    }
    const session = sessionAt(payload.position)
    if (payload.type === 'drop') {
      highlight(null)
      const { x, y } = dropPoint(payload.position, window.devicePixelRatio || 1, /Mac/.test(navigator.platform))
      const node = document.elementFromPoint(x, y)
      const over = session ? 'pane' : node?.closest('[data-file-drop-own]') ? 'own-target' : 'other'
      void (async () => {
        const option = over === 'pane' ? await optionHeldNow() : false
        const folder = over === 'own-target' || (over === 'pane' && !option) ? null : await firstFolder(payload.paths)
        const route = routeDrop(over, option, folder !== null)
        if (route === 'paste') session?.pastePaths(payload.paths)
        else if (route === 'folder' && folder) await (await import('./externalAgents')).bringInFolder(folder)
      })()
      return
    }
    highlight(session?.element ?? null)
  })
  return () => {
    highlight(null)
    unlisten()
  }
}

const AREA_CLASS = 'bs-file-drop-target'

/**
 * Listen for native file drops over one element (the Pinned view). Adds its own
 * listener while mounted, so it never competes with the terminal drop above:
 * that one only acts when the pointer is over a terminal. Returns a cleanup.
 */
export async function watchFileDrop(getElement: () => HTMLElement | null, onDrop: (paths: string[]) => void): Promise<() => void> {
  const over = (position: { x: number; y: number }) => {
    const element = getElement()
    if (!element) return false
    const { x, y } = dropPoint(position, window.devicePixelRatio || 1, /Mac/.test(navigator.platform))
    const node = document.elementFromPoint(x, y)
    return !!node && element.contains(node)
  }
  const unlisten = await getCurrentWebview().onDragDropEvent(({ payload }) => {
    const element = getElement()
    if (payload.type === 'leave') { element?.classList.remove(AREA_CLASS); return }
    const inside = over(payload.position)
    element?.classList.toggle(AREA_CLASS, inside && payload.type !== 'drop')
    if (payload.type === 'drop' && inside && payload.paths.length > 0) onDrop(payload.paths)
  })
  return () => { getElement()?.classList.remove(AREA_CLASS); unlisten() }
}
