// Code-da0.8 — persisted Designer column widths.
//
// The Designer body is a three-column grid: navigation, the main view, and
// the gates/conductor/agents panel. Users can drag or keyboard-resize the two
// side columns; widths are clamped so the main view always keeps usable room
// and are saved through the durable user-config allowlist so a DMG upgrade
// keeps them.

import { persistDurableUserConfigKey } from '../../lib/durableUserConfig'

export const DESIGNER_LAYOUT_KEY = 'beads-station.designer-layout.v1'

export interface DesignerLayout {
  left: number
  right: number
}

export const DEFAULT_DESIGNER_LAYOUT: DesignerLayout = { left: 220, right: 280 }
export const COLUMN_LIMITS = {
  left: { min: 160, max: 420 },
  right: { min: 220, max: 560 },
} as const

export function clampColumn(side: keyof DesignerLayout, width: number): number {
  const { min, max } = COLUMN_LIMITS[side]
  if (!Number.isFinite(width)) return DEFAULT_DESIGNER_LAYOUT[side]
  return Math.round(Math.min(max, Math.max(min, width)))
}

export function loadDesignerLayout(): DesignerLayout {
  try {
    const saved = JSON.parse(localStorage.getItem(DESIGNER_LAYOUT_KEY) ?? 'null') as Partial<DesignerLayout> | null
    if (!saved || typeof saved !== 'object') return DEFAULT_DESIGNER_LAYOUT
    return {
      left: clampColumn('left', Number(saved.left ?? DEFAULT_DESIGNER_LAYOUT.left)),
      right: clampColumn('right', Number(saved.right ?? DEFAULT_DESIGNER_LAYOUT.right)),
    }
  } catch {
    return DEFAULT_DESIGNER_LAYOUT
  }
}

export function saveDesignerLayout(layout: DesignerLayout): void {
  try {
    localStorage.setItem(DESIGNER_LAYOUT_KEY, JSON.stringify(layout))
  } catch {
    return
  }
  persistDurableUserConfigKey(DESIGNER_LAYOUT_KEY)
}
