import { beforeEach, describe, expect, it } from 'vitest'
import { setBeadsView, setUiPreferences } from './uiPreferences'

describe('ui preferences view recovery', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('unhides a collapsed Explorer when selecting Explorer from Settings or View', () => {
    setUiPreferences({ view: 'board', sidebarCollapsed: true })
    setBeadsView('explorer')

    expect(JSON.parse(localStorage.getItem('beads-station.ui-preferences')!)).toMatchObject({
      view: 'explorer',
      sidebarCollapsed: false,
    })
  })

  it('also restores the Explorer for the combined view', () => {
    setUiPreferences({ view: 'terminal-only', sidebarCollapsed: true })
    setBeadsView('both')

    expect(JSON.parse(localStorage.getItem('beads-station.ui-preferences')!)).toMatchObject({
      view: 'both',
      sidebarCollapsed: false,
    })
  })
})
