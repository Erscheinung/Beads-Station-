import { describe, expect, it } from 'vitest'
import { compilePattern, highlightSegments, makeSnippet, matchLabel, matchesInLine, queryWords, rehypeMark, searchSources, stepIndex, toHex, type SearchSource } from './find'

describe('stepIndex and matchLabel', () => {
  it('wraps in both directions and handles no matches', () => {
    expect(stepIndex(0, 3, 1)).toBe(1)
    expect(stepIndex(2, 3, 1)).toBe(0)
    expect(stepIndex(0, 3, -1)).toBe(2)
    expect(stepIndex(-1, 3, 1)).toBe(0)
    expect(stepIndex(-1, 3, -1)).toBe(2)
    expect(stepIndex(0, 0, 1)).toBe(-1)
  })
  it('says how many matches there are', () => {
    expect(matchLabel(2, 17, 'x')).toBe('3 / 17')
    expect(matchLabel(-1, 0, 'x')).toBe('No results')
    expect(matchLabel(-1, 0, '')).toBe('')
  })
})

describe('compilePattern', () => {
  it('escapes plain text and honours case', () => {
    const plain = compilePattern('a.b', { caseSensitive: false, regex: false })
    expect(plain.ok && matchesInLine('A.B aXb', plain.pattern)).toEqual([[0, 3]])
    const sensitive = compilePattern('Foo', { caseSensitive: true, regex: false })
    expect(sensitive.ok && matchesInLine('foo Foo', sensitive.pattern)).toEqual([[4, 3]])
  })
  it('reports a bad regex instead of throwing, and refuses empty matches', () => {
    const bad = compilePattern('(', { caseSensitive: false, regex: true })
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.error).toBeTruthy()
    expect(compilePattern('a*', { caseSensitive: false, regex: true }).ok).toBe(false)
    expect(compilePattern('', { caseSensitive: false, regex: true }).ok).toBe(false)
    const ok = compilePattern('\\d+', { caseSensitive: false, regex: true })
    expect(ok.ok && matchesInLine('a 12 b 345', ok.pattern)).toEqual([[2, 2], [7, 3]])
  })
})

describe('workspace search', () => {
  const source = (id: string, lines: string[]): SearchSource => ({ id, title: `Pane ${id}`, kind: 'terminal', lines: () => lines })
  const pattern = (text: string) => { const result = compilePattern(text, { caseSensitive: false, regex: false }); if (!result.ok) throw new Error('bad'); return result.pattern }

  it('groups hits by pane with a snippet around the match', async () => {
    const results = await searchSources([source('a', ['nothing', 'the Needle here']), source('b', ['no']), source('c', ['needle needle'])], pattern('needle'), { yieldFn: async () => {} })
    expect(results.groups.map(group => [group.id, group.hits.length])).toEqual([['a', 1], ['c', 2]])
    expect(results.total).toBe(3)
    expect(results.groups[0].hits[0]).toMatchObject({ line: 1, col: 4, length: 6 })
    expect(results.groups[0].hits[0].snippet).toEqual({ before: 'the ', match: 'Needle', after: ' here' })
  })
  it('stops at the cap and says so', async () => {
    const lines = Array.from({ length: 500 }, () => 'hit')
    const results = await searchSources([source('a', lines), source('b', lines)], pattern('hit'), { max: 200, yieldFn: async () => {} })
    expect(results.total).toBe(200)
    expect(results.capped).toBe(true)
    expect(results.groups).toHaveLength(1)
  })
  it('yields between panes and ends early when cancelled', async () => {
    let yields = 0
    const signal = { cancelled: false }
    const results = await searchSources([source('a', ['hit']), source('b', ['hit']), source('c', ['hit'])], pattern('hit'), { yieldFn: async () => { yields++; signal.cancelled = yields >= 2 }, signal })
    expect(yields).toBe(2)
    expect(results.groups.map(group => group.id)).toEqual(['a', 'b'])
  })
  it('clips long lines in the snippet', () => {
    const snippet = makeSnippet(`${'x'.repeat(100)}match${'y'.repeat(100)}`, 100, 5, 10)
    expect(snippet.before.startsWith('…')).toBe(true)
    expect(snippet.after.endsWith('…')).toBe(true)
    expect(snippet.match).toBe('match')
  })
})

describe('highlighting text', () => {
  it('marks every word case-insensitively and merges overlaps', () => {
    expect(queryWords('Especially  especially Fix')).toEqual(['especially', 'fix'])
    expect(highlightSegments('Fix it, especially FIX', ['especially', 'fix'])).toEqual([
      { text: 'Fix', match: true }, { text: ' it, ', match: false }, { text: 'especially', match: true }, { text: ' ', match: false }, { text: 'FIX', match: true },
    ])
    expect(highlightSegments('abcd', ['abc', 'bcd'])).toEqual([{ text: 'abcd', match: true }])
    expect(highlightSegments('plain', [])).toEqual([{ text: 'plain', match: false }])
  })
  it('keeps markup as text and only wraps text nodes in a hast tree', () => {
    const tree: any = { type: 'root', children: [
      { type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: 'a <img src=x onerror=1> hit' }] },
    ] }
    rehypeMark(['hit', '<img'])()(tree)
    const children = tree.children[0].children
    expect(children.map((node: any) => node.type === 'text' ? node.value : `<mark>${node.children[0].value}</mark>`)).toEqual(['a ', '<mark><img</mark>', ' src=x onerror=1> ', '<mark>hit</mark>'])
    expect(children.every((node: any) => node.type === 'text' || node.tagName === 'mark')).toBe(true)
  })
})

describe('toHex', () => {
  it('reads the colour forms a theme variable may have', () => {
    expect(toHex(' #E0AF68 ')).toBe('#e0af68')
    expect(toHex('#fa0')).toBe('#ffaa00')
    expect(toHex('rgb(224, 175, 104)')).toBe('#e0af68')
    expect(toHex('var(--x)')).toBeNull()
  })
})
