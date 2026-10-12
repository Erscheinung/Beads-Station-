import { describe, expect, it } from 'vitest'
import { agentResumeCommand, agentStartCommand, isAgentSessionId } from './agentHooks'

const ID = '2c975569-13c1-43b2-8e7a-f88d6138d7d8'
const SETTINGS = '/tmp/Application Support/ai.beads-station.desktop/agent-hooks/claude-settings.json'

describe('agent CLI command lines', () => {
  it('resumes the exact session when it is known and the latest one otherwise', () => {
    expect(agentResumeCommand('claude', ID, null)).toBe(`claude --resume ${ID}`)
    expect(agentResumeCommand('claude', undefined, null)).toBe('claude --continue')
    expect(agentResumeCommand('codex', ID, null)).toBe(`codex resume ${ID} -c tui.notifications=true -c tui.notification_method=osc9`)
    expect(agentResumeCommand('codex', null, null)).toContain('codex resume --last')
  })
  it('never puts an unvalidated id on a command line', () => {
    expect(isAgentSessionId('x; rm -rf ~')).toBe(false)
    expect(agentResumeCommand('claude', 'x; rm -rf ~', null)).toBe('claude --continue')
    expect(agentResumeCommand('codex', '$(whoami)', null)).toContain('resume --last')
  })
  it('passes the hook settings file quoted, and a first prompt as one argument', () => {
    expect(agentResumeCommand('claude', ID, SETTINGS)).toBe(`claude --settings '${SETTINGS}' --resume ${ID}`)
    expect(agentStartCommand('claude', "Fix Bob's header", SETTINGS)).toBe(`claude --settings '${SETTINGS}' 'Fix Bob'\\''s header'`)
    expect(agentStartCommand('codex', null, SETTINGS)).toBe('codex -c tui.notifications=true -c tui.notification_method=osc9')
  })
})
