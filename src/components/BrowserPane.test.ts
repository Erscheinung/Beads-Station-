import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

import { plainHttpInsideSecureApp } from './BrowserPane'

describe('plainHttpInsideSecureApp', () => {
  it('flags a plain http page only when the app page itself is not http', () => {
    expect(plainHttpInsideSecureApp('http://localhost:3000', 'tauri:')).toBe(true)
    expect(plainHttpInsideSecureApp('http://localhost:3000', 'https:')).toBe(true)
    expect(plainHttpInsideSecureApp('http://localhost:3000', 'http:')).toBe(false)
    expect(plainHttpInsideSecureApp('https://example.com', 'tauri:')).toBe(false)
  })
})
