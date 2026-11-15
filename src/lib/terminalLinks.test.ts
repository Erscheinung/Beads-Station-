import { describe, expect, it } from 'vitest'
import { editorOpenCommand, findFilePaths, findMarkdownPaths, isOpenableWebUrl, isViEditor, markdownDirectory, resolveLinkedPath, viEditKeys } from './terminalLinks'

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

describe('findFilePaths', () => {
  it('finds paths with an optional line and column', () => {
    const found = findFilePaths('error in src/lib/a.ts:12:5, see ./docs/plan.md and ~/notes/todo.md:3 then README.md.')
    expect(found.map(m => [m.path, m.line, m.col])).toEqual([
      ['src/lib/a.ts', 12, 5],
      ['./docs/plan.md', null, null],
      ['~/notes/todo.md', 3, null],
      ['README.md', null, null],
    ])
    expect(found[0].text).toBe('src/lib/a.ts:12:5')
  })
  it('covers the whole link text so the underline matches what opens', () => {
    const [m] = findFilePaths('  --> src/pty.rs:850:34')
    expect(m).toMatchObject({ start: 6, end: 23, path: 'src/pty.rs', line: 850, col: 34 })
  })
  it('skips URLs, versions, abbreviations and bare domains', () => {
    for (const line of ['https://example.com/readme.md', 'v0.2.0 and 1.2.3', 'e.g. this', 'visit example.com', 'user@host.io', 'a folder src/components here']) {
      expect(findFilePaths(line)).toEqual([])
    }
  })
})

describe('resolveLinkedPath', () => {
  it('joins relative paths to the folder and leaves ~ for the shell', () => {
    expect(resolveLinkedPath('docs/a.md', '/home/dev/app')).toBe('/home/dev/app/docs/a.md')
    expect(resolveLinkedPath('../a.md', '/home/dev/app')).toBe('/home/dev/a.md')
    expect(resolveLinkedPath('/x/./y/a.md', null)).toBe('/x/y/a.md')
    expect(resolveLinkedPath('~/notes/a.md', null)).toBe('~/notes/a.md')
    expect(resolveLinkedPath('a.md', '')).toBeNull()
  })
})

describe('editorOpenCommand', () => {
  it('jumps to the line in vi-like editors and quotes awkward names', () => {
    expect(editorOpenCommand('nvim', '/p/a.md')).toBe('nvim /p/a.md')
    expect(editorOpenCommand('nvim', '/p/a.ts', 12)).toBe('nvim +12 /p/a.ts')
    expect(editorOpenCommand('nvim', '/p/a.ts', 12, 5)).toBe("nvim '+call cursor(12,5)' /p/a.ts")
    expect(editorOpenCommand('nvim', "/p/my notes/it's.md", 3)).toBe("nvim +3 '/p/my notes/it'\\''s.md'")
    expect(editorOpenCommand('nvim', '~/my notes/a.md')).toBe("~/'my notes/a.md'".replace(/^/, 'nvim '))
    expect(editorOpenCommand('nvim', '/p/$(reboot).md')).toBe("nvim '/p/$(reboot).md'")
  })
  it('uses each editor family\'s own way of naming a position', () => {
    expect(editorOpenCommand('code', '/p/a.ts', 12, 5)).toBe('code --goto /p/a.ts:12:5')
    expect(editorOpenCommand('zed', '/p/a.ts', 12)).toBe('zed /p/a.ts:12')
    expect(editorOpenCommand('my-editor --flag', '/p/a.ts', 12)).toBe('my-editor --flag /p/a.ts')
    expect(isViEditor('/opt/homebrew/bin/nvim -u NONE')).toBe(true)
    expect(isViEditor('code')).toBe(false)
  })
})

describe('viEditKeys', () => {
  it('leaves any mode first, escapes the name for the command line, and never ends without Enter', () => {
    expect(viEditKeys('/p/a.ts', 12, 5)).toBe('\x1b:edit +12 /p/a.ts\r5|')
    expect(viEditKeys('/p/my notes/a%b.md')).toBe('\x1b:edit /p/my\\ notes/a\\%b.md\r')
  })
})
