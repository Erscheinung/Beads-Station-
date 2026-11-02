// Pointer drags for seams, resizers and tab reordering.
//
// Two things make a plain mousemove/mouseup pair unreliable here. An iframe
// swallows pointer events, so a release over a browser pane never arrives and
// the drag follows the cursor with no button held. And WKWebView delivers no
// HTML5 drag events while native file drops are on, so `draggable` does nothing.

interface DragHandlers {
  cursor?: string
  onMove: (event: PointerEvent) => void
  onEnd?: () => void
}

export function startPointerDrag({ cursor, onMove, onEnd }: DragHandlers): void {
  const root = document.documentElement
  root.classList.add('bs-dragging')
  if (cursor) root.style.setProperty('--bs-drag-cursor', cursor)
  const finish = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish)
    window.removeEventListener('blur', finish)
    root.classList.remove('bs-dragging')
    root.style.removeProperty('--bs-drag-cursor')
    onEnd?.()
  }
  const move = (event: PointerEvent) => {
    // The release happened somewhere that could not report it.
    if (event.buttons === 0) { finish(); return }
    onMove(event)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', finish)
  window.addEventListener('blur', finish)
}

const DRAG_THRESHOLD_PX = 5
const DROP_CLASS = 'bs-reorder-target'

/** Drag a tab onto another tab. `attribute` names the data attribute holding each tab's id. */
export function startPointerReorder(
  event: { button: number; clientX: number; clientY: number },
  id: string,
  attribute: string,
  onDrop: (from: string, to: string) => void,
): void {
  if (event.button !== 0) return
  const { clientX: startX, clientY: startY } = event
  let dragging = false
  let target: HTMLElement | null = null
  const setTarget = (next: HTMLElement | null) => {
    if (next === target) return
    target?.classList.remove(DROP_CLASS)
    target = next
    target?.classList.add(DROP_CLASS)
  }
  startPointerDrag({
    onMove: move => {
      if (!dragging && Math.hypot(move.clientX - startX, move.clientY - startY) < DRAG_THRESHOLD_PX) return
      dragging = true
      const under = document.elementFromPoint(move.clientX, move.clientY)?.closest<HTMLElement>(`[${attribute}]`) ?? null
      setTarget(under?.getAttribute(attribute) === id ? null : under)
    },
    onEnd: () => {
      const to = target?.getAttribute(attribute) ?? null
      setTarget(null)
      if (to) onDrop(id, to)
      if (dragging) {
        // The click that ends a drag must not also select the tab.
        const swallow = (click: MouseEvent) => { click.stopPropagation(); click.preventDefault() }
        window.addEventListener('click', swallow, { capture: true, once: true })
        // No click follows a release outside the tab; do not eat a later one.
        setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
      }
    },
  })
}
