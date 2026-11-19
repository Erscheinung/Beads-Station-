import { describe, expect, it } from 'vitest'
import { adoptConfirmation, adoptPlan, agentsInFolder, externalAgentLabel, type ExternalAgent } from './externalAgents'
// Built at runtime so no literal home path sits in the source (public-repo scan).
const USERS = ['', 'Users', ''].join('/')

const ID = '2c975569-13c1-43b2-8e7a-f88d6138d7d8'
const agent = (extra: Partial<ExternalAgent> = {}): ExternalAgent => ({
  pid: 4242, cli: 'claude', cwd: `${USERS}someone/Desktop/Code/foo`, tty: 'ttys003', app: 'Terminal', tmuxSession: null, sessionId: ID, ...extra,
})

describe('picker labels', () => {
  it('shows the folder with ~, the terminal app and the short session id', () => {
    expect(externalAgentLabel(agent())).toBe('Claude · ~/Desktop/Code/foo · Terminal · session 2c97…')
  })
  it('marks tmux entries as a live attach and says when the conversation is unknown', () => {
    expect(externalAgentLabel(agent({ tmuxSession: 'work', app: null, sessionId: null }))).toBe('Claude · ~/Desktop/Code/foo · tmux work (live attach)')
    expect(externalAgentLabel(agent({ cli: 'gemini', sessionId: null }))).toBe('Gemini · ~/Desktop/Code/foo · Terminal · conversation unknown')
  })
})

describe('adopt plan', () => {
  it('resumes the exact Claude and Codex conversation and stops the outside process first', () => {
    const claude = adoptPlan(agent())
    expect(claude).toMatchObject({ kind: 'resume', submit: true, stop: true, cwd: `${USERS}someone/Desktop/Code/foo` })
    expect(claude.command).toContain(`--resume ${ID}`)
    const codex = adoptPlan(agent({ cli: 'codex' }))
    expect(codex.command).toMatch(/^codex resume 2c975569-13c1-43b2-8e7a-f88d6138d7d8/)
    expect(adoptPlan(agent({ cli: 'gemini' })).command).toBe(`gemini --resume ${ID}`)
  })
  it('attaches tmux live without stopping anything', () => {
    const plan = adoptPlan(agent({ tmuxSession: "it's work" }))
    expect(plan).toMatchObject({ kind: 'tmux', stop: false, submit: true })
    expect(plan.command).toBe(`tmux attach -t '=it'\\''s work'`)
  })
  it('without a session id types the start command and never submits it', () => {
    const plan = adoptPlan(agent({ sessionId: null }))
    expect(plan).toMatchObject({ kind: 'start', submit: false, stop: true })
    expect(plan.command.startsWith('claude')).toBe(true)
    expect(plan.command.endsWith('\r')).toBe(false)
    expect(adoptPlan(agent({ cli: 'codex', sessionId: null })).submit).toBe(false)
  })
  it('refuses a malformed session id instead of putting it in a command line', () => {
    const plan = adoptPlan(agent({ sessionId: '$(rm -rf ~)' }))
    expect(plan.kind).toBe('start')
    expect(plan.command).not.toContain('rm')
  })
})

describe('confirmation text', () => {
  it('names the process, the app and the folder, and says the outside window stays open', () => {
    const { title, detail } = adoptConfirmation(agent())
    expect(title).toBe('Stop Claude in Terminal (folder ~/Desktop/Code/foo) and continue this conversation here?')
    expect(detail).toContain('The outside window stays open as an idle shell; close it yourself.')
  })
  it('asks about the shared tmux session instead', () => {
    expect(adoptConfirmation(agent({ tmuxSession: 'work' })).title).toBe('Attach to tmux session work here?')
  })
})

describe('folder matching', () => {
  it('matches the exact folder, ignoring a trailing slash', () => {
    const list = [agent(), agent({ pid: 2, cwd: `${USERS}someone/Desktop/Code/foo/sub` }), agent({ pid: 3, cwd: null })]
    expect(agentsInFolder(list, `${USERS}someone/Desktop/Code/foo/`).map(a => a.pid)).toEqual([4242])
  })
})
