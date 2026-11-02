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
      session?.pastePaths(payload.paths)
      return
    }
    highlight(session?.element ?? null)
  })
  return () => {
    highlight(null)
    unlisten()
  }
}
