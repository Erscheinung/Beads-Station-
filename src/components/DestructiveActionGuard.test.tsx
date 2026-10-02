import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DestructiveActionGuard } from './DestructiveActionGuard'
import { cancelDestructiveAction, getPendingDestructiveAction, requestDestructiveAction } from '../state/destructiveActions'
import { setSessionPreferences, shouldConfirmDestructiveActions } from '../state/sessionPreferences'

function ask(onConfirm = vi.fn()) {
  act(() => requestDestructiveAction({ kind: 'pane', title: 'Close terminal pane?', detail: 'Stops the shell.', onConfirm }))
  return onConfirm
}

describe('DestructiveActionGuard', () => {
  beforeEach(() => {
    act(() => { cancelDestructiveAction(); setSessionPreferences({ confirmDestructiveActions: true }) })
  })

  it('focuses the confirming button and confirms with Enter', () => {
    render(<DestructiveActionGuard />)
    const onConfirm = ask()
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Enter', repeat: true })
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('cancels with Escape, and Enter on Cancel cancels too', () => {
    render(<DestructiveActionGuard />)
    const first = ask()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(first).not.toHaveBeenCalled()
    expect(getPendingDestructiveAction()).toBeNull()

    const second = ask()
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    cancel.focus()
    fireEvent.keyDown(cancel, { key: 'Enter' })
    expect(second).not.toHaveBeenCalled()
    fireEvent.click(cancel)
    expect(getPendingDestructiveAction()).toBeNull()
  })

  it('applies "Don’t ask again" when Enter confirms, and starts unchecked next time', () => {
    render(<DestructiveActionGuard />)
    const onConfirm = ask()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(shouldConfirmDestructiveActions()).toBe(false)

    act(() => setSessionPreferences({ confirmDestructiveActions: true }))
    ask()
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })
})
