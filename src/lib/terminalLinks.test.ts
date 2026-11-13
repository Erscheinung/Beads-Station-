import { describe, expect, it } from 'vitest'
import { findMarkdownPaths, isOpenableWebUrl, markdownDirectory } from './terminalLinks'

describe('isOpenableWebUrl', () => {
  it('accepts http and https only', () => {
    expect(isOpenableWebUrl('https://example.com/a')).toBe(true)
    expect(isOpenableWebUrl('http://localhost:3000')).toBe(true)
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'ftp://x.test', 'vbscript:x', 'not a url', '']) {
      expect(isOpenableWebUrl(bad)).toBe(false)
    }
  })
})

describe('findMarkdownPaths', () => {
  it('finds relative and absolute markdown paths', () => {
    const line = 'edited docs/plan.md and ./README.markdown, /home/dev/x/notes.md.'
    expect(findMarkdownPaths(line).map(m => m.text)).toEqual(['docs/plan.md', './README.markdown', '/home/dev/x/notes.md'])
  })
  it('ignores URLs, other extensions and home paths', () => {
    expect(findMarkdownPaths('see https://example.com/readme.md')).toEqual([])
    expect(findMarkdownPaths('main.rs notes.mdx x.mdown')).toEqual([])
    expect(findMarkdownPaths('~/notes.md')).toEqual([])
  })
  it('reports offsets', () => {
    const [m] = findMarkdownPaths('a b.md')
    expect(m).toEqual({ text: 'b.md', start: 2, end: 6 })
  })
})

describe('markdownDirectory', () => {
  it('resolves against the pane folder', () => {
    expect(markdownDirectory('docs/a.md', '/home/dev/app')).toBe('/home/dev/app/docs')
    expect(markdownDirectory('../a.md', '/home/dev/app')).toBe('/home/dev')
    expect(markdownDirectory('/x/y/a.md', '/home/dev')).toBe('/x/y')
    expect(markdownDirectory('a.md', '/home/dev')).toBe('/home/dev')
    expect(markdownDirectory('a.md', 'relative')).toBeNull()
  })
})
