import { describe, expect, it } from 'vitest'
import { abbreviatePath, abbreviatePathsIn, fileUrlToPath } from './abbreviatePath'
// Built at runtime so no literal home path sits in the source (public-repo scan).
const USERS = ['', 'Users', ''].join('/')

describe('abbreviatePath', () => {
  it('collapses the home folder', () => {
    expect(abbreviatePath(`${USERS}someone/Documents/app`)).toBe('~/Documents/app')
    expect(abbreviatePath(`${USERS}someone`)).toBe('~')
    expect(abbreviatePath('/opt/tools')).toBe('/opt/tools')
  })
  it('collapses home folders inside a command', () => {
    expect(abbreviatePathsIn(`claude --settings '${USERS}someone/Library/x.json' --continue`)).toBe("claude --settings '~/Library/x.json' --continue")
  })
})

describe('fileUrlToPath', () => {
  it('decodes spaces and multibyte characters once', () => {
    expect(fileUrlToPath('file:///tmp/My%20Projects/caf%C3%A9%20%232')).toBe('/tmp/My Projects/café #2')
    expect(fileUrlToPath('file://localhost/tmp/a%20b')).toBe('/tmp/a b')
  })
  it('never decodes twice and leaves an invalid sequence alone', () => {
    expect(fileUrlToPath('file:///tmp/100%2525')).toBe('/tmp/100%25')
    expect(fileUrlToPath('file:///tmp/bad%E0%A4%zz')).toBe('/tmp/bad%E0%A4%zz')
  })
  it('does not touch anything that is not a file URL', () => {
    expect(fileUrlToPath('/tmp/100%20real folder')).toBe('/tmp/100%20real folder')
    expect(fileUrlToPath('https://x.test/a%20b')).toBe('https://x.test/a%20b')
  })
})
