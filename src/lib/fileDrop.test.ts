import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({}) }))
vi.mock('./terminalSessions', () => ({ terminalSessionForNode: () => null }))

import { dropPoint, routeDrop } from './fileDrop'

describe('drop position', () => {
  it('is already in points on macOS, so the right-hand pane stays on the right', () => {
    expect(dropPoint({ x: 1200, y: 300 }, 2, true)).toEqual({ x: 1200, y: 300 })
  })
  it('is scaled elsewhere', () => {
    expect(dropPoint({ x: 1200, y: 300 }, 2, false)).toEqual({ x: 600, y: 150 })
  })
})

describe('drop routing', () => {
  it('pastes on a pane, and brings a folder in only with Option held', () => {
    expect(routeDrop('pane', false, true)).toBe('paste')
    expect(routeDrop('pane', true, true)).toBe('folder')
    expect(routeDrop('pane', true, false)).toBe('paste')
  })
  it('opens a split for a folder on the chrome and ignores plain files there', () => {
    expect(routeDrop('other', false, true)).toBe('folder')
    expect(routeDrop('other', false, false)).toBe('ignore')
  })
  it('leaves areas with their own drop target alone', () => {
    expect(routeDrop('own-target', false, true)).toBe('ignore')
  })
})
