import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelDestructiveAction, getPendingDestructiveAction, requestDestructiveAction, resolveDestructiveAction } from './destructiveActions'
import { setSessionPreferences } from './sessionPreferences'

describe('destructive action confirmation', () => {
  beforeEach(() => {
    cancelDestructiveAction()
    setSessionPreferences({ confirmDestructiveActions: true })
  })

  it('holds a destructive action until it is confirmed and can disable future prompts', () => {
    const onConfirm = vi.fn()
    requestDestructiveAction({ kind: 'pane', title: 'Close terminal pane?', detail: 'Stops the shell.', onConfirm })

    expect(getPendingDestructiveAction()?.kind).toBe('pane')
    expect(onConfirm).not.toHaveBeenCalled()
    resolveDestructiveAction(true, true)

    expect(onConfirm).toHaveBeenCalledOnce()
    expect(getPendingDestructiveAction()).toBeNull()

    const next = vi.fn()
    requestDestructiveAction({ kind: 'workspace', title: 'Close workspace?', detail: 'Stops sessions.', onConfirm: next })
    expect(next).toHaveBeenCalledOnce()
    expect(getPendingDestructiveAction()).toBeNull()
  })

  it('cancels without invoking the destructive action', () => {
    const onConfirm = vi.fn()
    requestDestructiveAction({ kind: 'pane', title: 'Close terminal pane?', detail: 'Stops the shell.', onConfirm })
    resolveDestructiveAction(false, false)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(getPendingDestructiveAction()).toBeNull()
  })
})
