import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({}) }))
vi.mock('./terminalSessions', () => ({ terminalSessionForNode: () => null }))

import { dropPoint } from './fileDrop'

describe('drop position', () => {
  it('is already in points on macOS, so the right-hand pane stays on the right', () => {
    expect(dropPoint({ x: 1200, y: 300 }, 2, true)).toEqual({ x: 1200, y: 300 })
  })
  it('is scaled elsewhere', () => {
    expect(dropPoint({ x: 1200, y: 300 }, 2, false)).toEqual({ x: 600, y: 150 })
  })
})
