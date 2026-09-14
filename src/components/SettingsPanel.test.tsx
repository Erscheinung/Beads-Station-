import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  // Keep provider discovery pending; these tests exercise settings shortcuts
  // and should not schedule an unrelated external-store update after render.
  invoke: vi.fn(() => new Promise<never>(() => {})),
}))
vi.mock('../lib/listenerRegistry', () => ({
  safeListen: vi.fn(async () => () => {}),
}))

import { SettingsPanel } from './SettingsPanel'
import { closeSettings, openSettings } from '../state/settings'
import { getBinding, resetBindings } from '../state/commands'

function installDialogMethods(): void {
  if (!HTMLDialogElement.prototype.showModal) {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value() { this.setAttribute('open', '') },
    })
  }
  if (!HTMLDialogElement.prototype.close) {
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value() { this.removeAttribute('open') },
    })
  }
}

function renderShortcuts() {
  installDialogMethods()
  act(() => openSettings())
  render(<SettingsPanel />)
  fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts', exact: true }))
}

describe('SettingsPanel shortcut recorder', () => {
  beforeEach(() => {
    act(() => {
      resetBindings()
      closeSettings()
    })
    localStorage.clear()
  })

  afterEach(() => {
    act(() => closeSettings())
  })

  it('starts from a pointer click and captures after focus moves away', async () => {
    renderShortcuts()
    const record = screen.getByRole('button', { name: 'Shortcut for Open workspace' })
    fireEvent.click(record)
    expect(record).toHaveTextContent('Press shortcut…')

    const otherInput = document.createElement('input')
    document.body.append(otherInput)
    otherInput.focus()
    act(() => fireEvent.keyDown(otherInput, { key: 'o', metaKey: true, bubbles: true }))

    await waitFor(() => expect(record).toHaveTextContent('Ctrl O'))
    expect(getBinding('workspace')).toBe('Mod+O')
    expect(JSON.parse(localStorage.getItem('beads-station.command-bindings.v1')!).workspace).toBe('Mod+O')
    otherInput.remove()
  })

  it('starts from keyboard activation and keeps conflicts visible until corrected', async () => {
    renderShortcuts()
    const record = screen.getByRole('button', { name: 'Shortcut for Open workspace' })
    record.focus()
    fireEvent.keyDown(record, { key: 'Enter', bubbles: true })
    expect(record).toHaveTextContent('Press shortcut…')

    act(() => fireEvent.keyDown(document.body, { key: 'k', metaKey: true, bubbles: true }))
    expect(screen.getByRole('alert')).toHaveTextContent('Already assigned to Command palette')
    expect(record).toHaveTextContent('Press shortcut…')
    expect(getBinding('workspace')).toBe('')

    act(() => fireEvent.keyDown(document.body, { key: 'o', ctrlKey: true, bubbles: true }))
    await waitFor(() => expect(record).toHaveTextContent('Ctrl O'))
    expect(getBinding('workspace')).toBe('Mod+O')
  })

  it('clearing an active binding disables Clear and cancels capture', async () => {
    renderShortcuts()
    const record = screen.getByRole('button', { name: 'Shortcut for Open workspace' })
    fireEvent.click(record)
    act(() => fireEvent.keyDown(document.body, { key: 'o', ctrlKey: true, bubbles: true }))
    await waitFor(() => expect(record).toHaveTextContent('Ctrl O'))

    const clear = screen.getByRole('button', { name: 'Clear shortcut for Open workspace' })
    expect(clear).toBeEnabled()
    fireEvent.click(clear)
    expect(record).toHaveTextContent('Record shortcut')
    expect(clear).toBeDisabled()

    fireEvent.click(record)
    expect(record).toHaveTextContent('Press shortcut…')
    act(() => fireEvent.keyDown(document.body, { key: 'Escape', bubbles: true }))
    expect(record).toHaveTextContent('Record shortcut')
  })
})
