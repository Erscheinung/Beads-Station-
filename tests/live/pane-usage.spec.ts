import { test, expect, seedConfirmed, emit } from './helpers'
import type { Page } from '@playwright/test'

// Code-7xc.1: live usage of the agent in a terminal pane. Claude's status line
// wrapper reports through OSC 7770 (here injected as terminal output); Codex is
// found by the foreground poll and read from its rollout (mocked
// session_usage). Native PTY detection and real CLIs are a hands-on check.

const ID = '2c975569-13c1-43b2-8e7a-f88d6138d7d8'

const calls = (page: Page, cmd: string) => page.evaluate(name => (window as any).__bsInvokeLog.filter((e: any) => e.cmd === name), cmd)

async function output(page: Page, shell: number, data: string) {
  const spawn = (await calls(page, 'pty_spawn'))[shell]
  await emit(page, `pty_data:${spawn.args.eventKey}`, { id: 1, data })
}

test.beforeEach(async ({ page }) => {
  await seedConfirmed(page)
  await page.goto('/')
  await expect(page.locator('[data-terminal-phase="running"]')).toHaveCount(1)
})

test('a Claude status line report shows the pane chip and the limits in the status bar', async ({ page }) => {
  await expect(page.getByTestId('session-usage')).toHaveCount(0)
  await expect(page.getByTestId('statusline-limits')).toHaveCount(0)
  const resets = Math.floor(Date.now() / 1000) + 2 * 3600
  const report = JSON.stringify({ session_id: ID, context_window_size: 200000, five_hour: { used_percentage: 81, resets_at: resets }, seven_day: { used_percentage: 69, resets_at: resets + 86400 }, used_percentage: 42 })
  await output(page, 0, `\u001b]7770;usage;claude;${report}\u0007`)

  const chip = page.getByTestId('session-usage')
  // Context % from the status line, its size and subagents from the (mocked) session file.
  await expect(chip).toHaveText('Claude · ctx 42% · 84k (+2 subagents)')
  await expect(chip).toHaveAttribute('title', /This session: .* in · 1\.5M cached · 24k out/)
  const usageCall = (await calls(page, 'session_usage'))[0]
  expect(usageCall.args).toMatchObject({ provider: 'claude', sessionId: ID })

  const limits = page.getByTestId('statusline-limits')
  await expect(limits).toContainText(/Claude 5h 81% · wk 69% · resets \d\d:\d\d/)
  await expect(limits).not.toHaveAttribute('data-stale', 'true')
})

test('a Codex session found in the foreground shows its context and limits', async ({ page }) => {
  await page.evaluate(id => {
    (window as any).__bsMockOverride = { ...(window as any).__bsMockOverride, pty_foreground: { cli: 'codex', sessionId: id, program: 'codex', cwd: '/tmp' } }
  }, '01a12f2b-69d8-7ea0-a23b-0fd1d81cac0e')
  // The poll runs every 3 s while the pane is on screen.
  await expect(page.getByTestId('session-usage')).toHaveText('Codex · ctx 20% · 96k', { timeout: 15_000 })
  await expect(page.getByTestId('statusline-limits')).toContainText(/Codex 5h 81% · wk 69%/)

  // The agent quits: after two polls without it, the chip goes away.
  await page.evaluate(() => { (window as any).__bsMockOverride = { ...(window as any).__bsMockOverride, pty_foreground: { cli: null, sessionId: null } } })
  await expect(page.getByTestId('session-usage')).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByTestId('statusline-limits')).toHaveCount(0)
})
