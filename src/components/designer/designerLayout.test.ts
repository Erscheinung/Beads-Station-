import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/durableUserConfig', () => ({ persistDurableUserConfigKey: vi.fn() }))

import { persistDurableUserConfigKey } from '../../lib/durableUserConfig'
import { clampColumn, DEFAULT_DESIGNER_LAYOUT, DESIGNER_LAYOUT_KEY, loadDesignerLayout, saveDesignerLayout } from './designerLayout'

beforeEach(() => { localStorage.clear(); vi.clearAllMocks() })

describe('designer column layout', () => {
  it('defaults when nothing or garbage is saved', () => {
    expect(loadDesignerLayout()).toEqual(DEFAULT_DESIGNER_LAYOUT)
    localStorage.setItem(DESIGNER_LAYOUT_KEY, '{not json')
    expect(loadDesignerLayout()).toEqual(DEFAULT_DESIGNER_LAYOUT)
  })
  it('clamps saved widths so the main view keeps room', () => {
    localStorage.setItem(DESIGNER_LAYOUT_KEY, JSON.stringify({ left: 9999, right: 10 }))
    expect(loadDesignerLayout()).toEqual({ left: 420, right: 220 })
    expect(clampColumn('left', Number.NaN)).toBe(DEFAULT_DESIGNER_LAYOUT.left)
  })
  it('round-trips and mirrors into durable app-data config', () => {
    saveDesignerLayout({ left: 300, right: 360 })
    expect(loadDesignerLayout()).toEqual({ left: 300, right: 360 })
    expect(persistDurableUserConfigKey).toHaveBeenCalledWith(DESIGNER_LAYOUT_KEY)
  })
})
