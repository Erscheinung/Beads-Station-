import { startPointerDrag } from '../../lib/pointerDrag'
import { clampColumn, DEFAULT_DESIGNER_LAYOUT, type DesignerLayout } from './designerLayout'

const KEY_STEP = 16

interface ColumnResizerProps {
  side: keyof DesignerLayout
  width: number
  label: string
  /** Live update while dragging or pressing keys. */
  onResize: (width: number) => void
  /** Commit point: pointer release, key press, or reset. */
  onCommit: (width: number) => void
}

/**
 * A 1px hairline with a wider invisible hit area between two Designer
 * columns. Drag to resize, use Left/Right arrows when focused, and
 * double-click (or press Enter) to restore the default width.
 */
export function ColumnResizer({ side, width, label, onResize, onCommit }: ColumnResizerProps) {
  // The left column grows when dragging right; the right column grows when
  // dragging left.
  const direction = side === 'left' ? 1 : -1

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    let latest = width
    startPointerDrag({
      cursor: 'col-resize',
      onMove: move => {
        latest = clampColumn(side, startWidth + direction * (move.clientX - startX))
        onResize(latest)
      },
      onEnd: () => onCommit(latest),
    })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = width - direction * KEY_STEP
    else if (event.key === 'ArrowRight') next = width + direction * KEY_STEP
    else if (event.key === 'Enter') next = DEFAULT_DESIGNER_LAYOUT[side]
    if (next === null) return
    event.preventDefault()
    const clamped = clampColumn(side, next)
    onResize(clamped)
    onCommit(clamped)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      tabIndex={0}
      className="bs-designer-resizer"
      data-bs-designer-resizer={side}
      onPointerDown={startDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => {
        onResize(DEFAULT_DESIGNER_LAYOUT[side])
        onCommit(DEFAULT_DESIGNER_LAYOUT[side])
      }}
      title="Drag to resize · double-click to reset"
    />
  )
}
