import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MorningConfirm } from './MorningConfirm'

function renderConfirm() {
  const handlers = { onResume: vi.fn(), onNew: vi.fn(), onCancel: vi.fn() }
  const view = render(
    <MorningConfirm
      projectName="Example repo"
      sessionId="provider-session"
      {...handlers}
    />,
  )
  return { ...handlers, ...view }
}

describe('MorningConfirm', () => {
  it('shows the observed session and requires an explicit action', () => {
    const { onResume, onNew } = renderConfirm()
    expect(screen.getByText('Example repo · provider-session')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(onResume).toHaveBeenCalledOnce()
    expect(onNew).not.toHaveBeenCalled()
  })

  it('cancels the pending start on Escape, Cancel, or backdrop click', () => {
    const first = renderConfirm()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(first.onCancel).toHaveBeenCalledOnce()
    first.unmount()

    const second = renderConfirm()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(second.onCancel).toHaveBeenCalledOnce()
    second.unmount()

    const third = renderConfirm()
    fireEvent.click(screen.getByRole('dialog'))
    expect(third.onCancel).toHaveBeenCalledOnce()
    expect(third.onResume).not.toHaveBeenCalled()
  })

  it('starts fresh only from New session', () => {
    const { onNew, onResume, onCancel } = renderConfirm()
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(onNew).toHaveBeenCalledOnce()
    expect(onResume).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })
})
