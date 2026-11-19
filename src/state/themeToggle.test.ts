import { describe, expect, it } from 'vitest'
import { nextThemeId } from './theme'

const ids = ['a', 'b', 'c', 'd']

describe('nextThemeId', () => {
  it('walks every theme in order and wraps', () => {
    let cur = 'a'
    const seen: string[] = []
    for (let i = 0; i < 4; i++) { cur = nextThemeId(ids, cur, 'series', []).id; seen.push(cur) }
    expect(seen).toEqual(['b', 'c', 'd', 'a'])
  })

  it('shuffle shows every other theme before any repeats', () => {
    let cur = 'a'
    let bag: string[] = []
    const seen: string[] = []
    for (let i = 0; i < 3; i++) { const r = nextThemeId(ids, cur, 'shuffle', bag, () => 0.99); cur = r.id; bag = r.bag; seen.push(cur) }
    expect(new Set(seen).size).toBe(3)
    expect(seen).not.toContain('a')
  })

  it('shuffle never picks the current theme, even across bag refills', () => {
    let cur = 'a'
    let bag: string[] = []
    for (let i = 0; i < 40; i++) {
      const r = nextThemeId(ids, cur, 'shuffle', bag, Math.random)
      expect(r.id).not.toBe(cur)
      cur = r.id; bag = r.bag
    }
  })
})
