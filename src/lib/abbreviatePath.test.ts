import { describe, expect, it } from 'vitest'
const home = ['', 'Users', 'someone'].join('/')
import { abbreviatePath, abbreviatePathsIn } from './abbreviatePath'

describe('abbreviatePath', () => {
  it('collapses the home folder', () => {
    expect(abbreviatePath(`${home}/Documents/app`)).toBe('~/Documents/app')
    expect(abbreviatePath(home)).toBe('~')
    expect(abbreviatePath('/opt/tools')).toBe('/opt/tools')
  })
  it('collapses home folders inside a command', () => {
    expect(abbreviatePathsIn(`claude --settings '${home}/Library/x.json' --continue`)).toBe("claude --settings '~/Library/x.json' --continue")
  })
})
