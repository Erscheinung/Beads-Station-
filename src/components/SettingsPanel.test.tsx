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
import { resetUiCustomization } from '../state/uiCustomization'
import appPackage from '../../package.json'

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
  fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }))
}

describe('SettingsPanel shortcut recorder', () => {
  beforeEach(() => {
    act(() => {
      resetBindings()
      resetUiCustomization()
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
    expect(record).toHaveTextContent('Not set')
    expect(clear).toBeDisabled()

    fireEvent.click(record)
    expect(record).toHaveTextContent('Press shortcut…')
    act(() => fireEvent.keyDown(document.body, { key: 'Escape', bubbles: true }))
    expect(record).toHaveTextContent('Not set')
  })

  it('groups every terminal pane action and records an easier binding', async () => {
    renderShortcuts()

    const terminalGroup = screen.getByRole('region', { name: 'Terminal pane controls' })
    expect(terminalGroup).toBeVisible()
    expect(terminalGroup.querySelectorAll('[aria-label^="Shortcut for"]')).toHaveLength(12)

    const focusLeft = screen.getByRole('button', { name: 'Shortcut for Focus terminal pane left' })
    expect(focusLeft).toHaveTextContent('Change')
    fireEvent.click(focusLeft)
    act(() => fireEvent.keyDown(document.body, { key: '1', metaKey: true, bubbles: true }))

    await waitFor(() => expect(getBinding('focusLeft')).toBe('Mod+1'))
    expect(focusLeft).toHaveTextContent('1')
  })
})

describe('SettingsPanel interface customization', () => {
  beforeEach(() => {
    act(() => {
      resetUiCustomization()
      closeSettings()
    })
    localStorage.clear()
  })

  afterEach(() => {
    act(() => closeSettings())
  })

  it('offers accessible scale and density controls and persists changes', () => {
    installDialogMethods()
    act(() => openSettings())
    render(<SettingsPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))

    const scale = screen.getByRole('slider', { name: 'Interface scale' })
    expect(scale).toHaveValue('100')
    fireEvent.change(scale, { target: { value: '115' } })
    expect(scale).toHaveValue('115')
    expect(document.documentElement.style.getPropertyValue('--bs-interface-scale')).toBe('1.15')

    const density = screen.getByRole('combobox', { name: 'Interface density' })
    fireEvent.change(density, { target: { value: 'compact' } })
    expect(density).toHaveValue('compact')
    expect(document.documentElement.dataset.bsDensity).toBe('compact')
    expect(JSON.parse(localStorage.getItem('beads-station.ui-customization.v1')!)).toEqual({ interfaceScale: 115, density: 'compact' })
  })

  it('restores both interface defaults with one clear action', () => {
    installDialogMethods()
    act(() => openSettings())
    render(<SettingsPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
    fireEvent.change(screen.getByRole('slider', { name: 'Interface scale' }), { target: { value: '85' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Interface density' }), { target: { value: 'compact' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reset interface customization' }))
    expect(screen.getByRole('slider', { name: 'Interface scale' })).toHaveValue('100')
    expect(screen.getByRole('combobox', { name: 'Interface density' })).toHaveValue('comfortable')
  })
})

describe('SettingsPanel about page', () => {
  beforeEach(() => {
    act(() => closeSettings())
  })

  afterEach(() => {
    act(() => closeSettings())
  })

  it('shows the version from application package metadata', () => {
    installDialogMethods()
    act(() => openSettings())
    render(<SettingsPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'About' }))

    expect(screen.getByTestId('app-version')).toHaveTextContent(`v${appPackage.version}`)
  })
})
