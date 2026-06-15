import type { CSSProperties, ReactNode } from 'react'
import { useDroppable } from '@dnd-kit/core'

interface ColumnProps {
  id: string
  title: string
  count: number
  children: ReactNode
}

/**
 * Droppable column. Highlights its background slightly while a card is
 * hovering over it. Header shows the column title and live item count.
 */
export function Column({ id, title, count, children }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id })

  const style: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    background: isOver ? 'color-mix(in srgb, var(--bs-blue) 8%, var(--bs-bg))' : 'var(--bs-bg)',
    border: '1px solid var(--bs-border)',
    borderRadius: 4,
    transition: 'background 120ms ease',
  }

  return (
    <div ref={setNodeRef} style={style}>
      <div
        style={{
          padding: '8px 10px',
          borderBottom: '1px solid var(--bs-border)',
          fontSize: 11,
          color: 'var(--bs-fg)',
          opacity: 0.7,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}
      >
        <span style={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>{title}</span>
        <span style={{ opacity: 0.6 }}>{count}</span>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: 6,
        }}
      >
        {children}
      </div>
    </div>
  )
}
