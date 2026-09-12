import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, isDragging: false }),
}))

import { Card } from './Card'
import type { Issue } from '../types/issue'

const issue: Issue = {
  id: 'Code-card1',
  title: 'Restore card activation',
  description: null,
  status: 'open',
  priority: 1,
  issue_type: 'task',
  assignee: null,
  created_at: '',
  updated_at: '',
  closed_at: null,
  dependency_count: 0,
  dependent_count: 0,
  comment_count: 0,
  labels: [],
  parent: null,
  dependencies: [],
}

describe('Board card activation', () => {
  it('opens on double-click and provides an Enter/Space keyboard equivalent', () => {
    const onOpen = vi.fn()
    render(<Card issue={issue} onOpen={onOpen} />)
    const card = screen.getByRole('button', { name: /Code-card1: Restore card activation/ })

    fireEvent.doubleClick(card)
    fireEvent.keyDown(card, { key: 'Enter' })
    fireEvent.keyDown(card, { key: ' ' })

    expect(onOpen).toHaveBeenCalledTimes(3)
    expect(onOpen).toHaveBeenCalledWith(issue)
  })

  it('does not treat pointer movement beyond the drag threshold as activation', () => {
    const onOpen = vi.fn()
    render(<Card issue={issue} onOpen={onOpen} />)
    const card = screen.getByRole('button', { name: /Code-card1: Restore card activation/ })

    fireEvent.pointerDown(card, { clientX: 10, clientY: 10 })
    fireEvent.pointerMove(card, { clientX: 30, clientY: 10, buttons: 1 })
    fireEvent.pointerUp(card, { clientX: 30, clientY: 10 })
    fireEvent.doubleClick(card)

    expect(onOpen).not.toHaveBeenCalled()
  })
})
