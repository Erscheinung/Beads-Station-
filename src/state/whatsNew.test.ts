import { describe, expect, it } from 'vitest'
import { LAST_SEEN_VERSION_KEY, RELEASE_HIGHLIGHTS, unseenHighlights } from './whatsNew'

function storage(values: Record<string, string>) {
  return { getItem: (key: string) => values[key] ?? null, length: Object.keys(values).length }
}

describe("what's new", () => {
  it('stays quiet on a first install', () => {
    expect(unseenHighlights('0.1.6', storage({}))).toEqual([])
  })
  it('shows the new release to someone upgrading from a version that kept no marker', () => {
    const shown = unseenHighlights('0.1.6', storage({ 'beads-station.theme': 'dark' }))
    expect(shown.map(release => release.version)).toEqual(['0.1.6'])
    expect(shown[0].items).toBe(RELEASE_HIGHLIGHTS['0.1.6'])
  })
  it('shows nothing once the running version has been seen, or for a release newer than the app', () => {
    expect(unseenHighlights('0.1.6', storage({ [LAST_SEEN_VERSION_KEY]: '0.1.6' }))).toEqual([])
    expect(unseenHighlights('0.1.5', storage({ [LAST_SEEN_VERSION_KEY]: '0.1.4' }))).toEqual([])
  })
})
