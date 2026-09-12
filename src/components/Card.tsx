import { useRef } from 'react'
import type { CSSProperties, KeyboardEventHandler, PointerEventHandler } from 'react'
import { useDraggable } from '@dnd-kit/core'
import type { Issue } from '../types/issue'

interface CardProps {
  issue: Issue
  onOpen: (issue: Issue) => void
}

/* tokyonight: --bs-red / --bs-yellow / --bs-blue.
 * These literals are kept as concrete hex values because a static map is
 * cheaper than a getComputedStyle round-trip per render. They are tokyonight
 * Storm syntax accents (priority pills are syntax-construct usage). If the
 * palette ever changes, update this map AND src/index.css together. */
const PRIORITY_COLORS: Record<number, string> = {
  1: '#f7768e', // P1 — --bs-red
  2: '#e0af68', // P2 — --bs-yellow
  3: '#7aa2f7', // P3 — --bs-blue
}

/**
 * A single draggable issue card. Drag handle covers the whole card. While
 * dragging we lift opacity / rotation / shadow; the dnd-kit DragOverlay (in
 * Board.tsx) renders the floating ghost so this element keeps its slot.
 */
export function Card({ issue, onOpen }: CardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: issue.id,
    data: { issue },
  })
  const pointerStart = useRef<{ x: number; y: number } | null>(null)
  const pointerDragged = useRef(false)

  const handlePointerDown: PointerEventHandler<HTMLDivElement> = event => {
    pointerStart.current = { x: event.clientX, y: event.clientY }
    pointerDragged.current = false
    listeners?.onPointerDown?.(event)
  }
  const handlePointerMove: PointerEventHandler<HTMLDivElement> = event => {
    const start = pointerStart.current
    if (start && (event.buttons !== 0 || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4)) {
      pointerDragged.current = true
    }
    listeners?.onPointerMove?.(event)
  }
  const handlePointerUp: PointerEventHandler<HTMLDivElement> = event => {
    listeners?.onPointerUp?.(event)
    pointerStart.current = null
  }
  const activate = () => {
    if (!isDragging) onOpen(issue)
  }
  const handleKeyDown: KeyboardEventHandler<HTMLDivElement> = event => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    activate()
  }

  const labels = issue.labels ?? []
  const visibleLabels = labels.slice(0, 2)
  const overflow = labels.length - visibleLabels.length

  const priorityColor = PRIORITY_COLORS[issue.priority] ?? PRIORITY_COLORS[3]

  // Priority bar: 3px inset --bs-red/--bs-yellow/--bs-blue on the left, plus a
  // 1px hairline border on the other three sides. We use inset box-shadow for
  // the bar so it doesn't shift the layout. The priority color is exposed as
  // a CSS custom property (--bs-card-bar) so the :hover rule in index.css can
  // compose its hairline lift on top of the priority bar without clobbering
  // the inset shadow.
  const style: CSSProperties = {
    background: 'var(--bs-bg-elev)',
    border: '1px solid var(--bs-border)',
    borderLeft: '1px solid transparent',
    borderRadius: 4,
    padding: '8px 10px 8px 12px',
    marginBottom: 6,
    fontSize: 12,
    cursor: 'grab',
    opacity: isDragging ? 0.55 : 1,
    transform: isDragging ? 'rotate(-2deg)' : undefined,
    boxShadow: isDragging
      ? `inset 3px 0 0 ${priorityColor}, var(--bs-shadow-card)`
      : `inset 3px 0 0 ${priorityColor}`,
    // CSS variable used by .bs-card:hover so the hover lift can keep the
    // priority bar intact.
    ['--bs-card-bar' as string]: priorityColor,
    userSelect: 'none',
    transition: 'background 120ms ease, box-shadow 120ms ease',
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="bs-card"
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      aria-label={`${issue.id}: ${issue.title}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={event => {
        event.preventDefault()
        if (!pointerDragged.current) activate()
      }}
      onKeyDown={handleKeyDown}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 4,
          fontSize: 10,
          color: 'var(--bs-fg)',
          opacity: 0.55,
        }}
      >
        <span>{issue.id}</span>
        <span
          style={{
            display: 'inline-block',
            padding: '0 6px',
            borderRadius: 8,
            fontSize: 10,
            color: 'var(--bs-bg-dark)',
            background: priorityColor,
            fontWeight: 600,
            opacity: 1,
          }}
        >
          P{issue.priority}
        </span>
        <span style={{ marginLeft: 'auto' }}>{issue.issue_type}</span>
      </div>
      <div
        style={{
          color: 'var(--bs-fg)',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          lineHeight: 1.35,
          fontSize: 13,
          fontWeight: 500,
        }}
      >
        {issue.title}
      </div>
      {labels.length > 0 && (
        <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
          {visibleLabels.map(l => (
            <span
              key={l}
              style={{
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 8,
                background: 'var(--bs-bg)',
                color: 'var(--bs-fg)',
                opacity: 0.7,
                border: '1px solid var(--bs-border)',
              }}
            >
              {l}
            </span>
          ))}
          {overflow > 0 && (
            <span
              style={{
                fontSize: 10,
                padding: '1px 6px',
                color: 'var(--bs-fg)',
                opacity: 0.5,
              }}
            >
              +{overflow}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
