import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_UI_CUSTOMIZATION, UI_CUSTOMIZATION_KEY, getUiCustomization, resetUiCustomization, setUiCustomization } from './uiCustomization'

describe('ui customization', () => {
  beforeEach(() => {
    localStorage.clear()
    resetUiCustomization()
  })

  it('clamps scale, validates density, persists and updates document presentation', () => {
    setUiCustomization({ interfaceScale: 999, density: 'compact' })

    expect(getUiCustomization()).toEqual({ interfaceScale: 120, density: 'compact' })
    expect(JSON.parse(localStorage.getItem(UI_CUSTOMIZATION_KEY)!)).toEqual({ interfaceScale: 120, density: 'compact' })
    expect(document.documentElement.dataset.bsDensity).toBe('compact')
    expect(document.documentElement.style.getPropertyValue('--bs-interface-scale')).toBe('1.2')
  })

  it('keeps the current value for invalid updates and restores defaults', () => {
    setUiCustomization({ interfaceScale: 85, density: 'compact' })
    setUiCustomization({ interfaceScale: Number.NaN, density: 'wide' as never })
    expect(getUiCustomization()).toEqual({ interfaceScale: 85, density: 'compact' })

    resetUiCustomization()
    expect(getUiCustomization()).toEqual(DEFAULT_UI_CUSTOMIZATION)
    expect(document.documentElement.dataset.bsDensity).toBe('comfortable')
    expect(document.documentElement.style.getPropertyValue('--bs-interface-scale')).toBe('1')
  })
})
