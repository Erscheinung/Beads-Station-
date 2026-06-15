import type { CSSProperties } from 'react'
import { useDraggable } from '@dnd-kit/core'
import type { Issue } from '../types/issue'

interface CardProps {
  issue: Issue
}

const PRIORITY_COLORS: Record<number, string> = {
  1: '#f7768e', // P1 red
  2: '#e0af68', // P2 yellow
  3: '#7aa2f7', // P3 blue (= --accent)
}

/**
 * A single draggable issue card. Drag handle covers the whole card. While
 * dragging we lift opacity / rotation / shadow; the dnd-kit DragOverlay (in
 * Board.tsx) renders the floating ghost so this element keeps its slot.
 */
export function Card({ issue }: CardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: issue.id,
    data: { issue },
  })

  const labels = issue.labels ?? []
  const visibleLabels = labels.slice(0, 2)
  const overflow = labels.length - visibleLabels.length

  const style: CSSProperties = {
    background: 'var(--bg-elev)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    padding: '8px 10px',
    marginBottom: 6,
    fontSize: 12,
    cursor: 'grab',
    opacity: isDragging ? 0.5 : 1,
    transform: isDragging ? 'rotate(-1deg)' : undefined,
    boxShadow: isDragging ? '0 6px 14px rgba(0,0,0,0.35)' : undefined,
    userSelect: 'none',
    transition: 'background 120ms ease',
  }

  const priorityColor = PRIORITY_COLORS[issue.priority] ?? PRIORITY_COLORS[3]

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="bs-card"
      {...listeners}
      {...attributes}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 4,
          fontSize: 10,
          color: 'var(--fg)',
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
            color: '#1a1b26',
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
          color: 'var(--fg)',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          lineHeight: 1.35,
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
                background: 'var(--bg)',
                color: 'var(--fg)',
                opacity: 0.7,
                border: '1px solid var(--border)',
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
                color: 'var(--fg)',
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
