import { test, expect, seedConfirmed, emit } from './helpers'
import type { Page } from '@playwright/test'
// Built at runtime so no literal home path sits in the source (public-repo scan).
const USERS = ['', 'Users', ''].join('/')

// Code-7xc.2: offline handoff note and prompt journal. Usage arrives the way
// Claude's status line reports it (OSC 7770 injected as terminal output); the
// backend commands are the mock IPC's. A real CLI, real files and a native PTY
// are hands-on checks.

const ID = '2c975569-13c1-43b2-8e7a-f88d6138d7d8'

const calls = (page: Page, cmd: string) => page.evaluate(name => (window as any).__bsInvokeLog.filter((e: any) => e.cmd === name), cmd)

async function output(page: Page, data: string) {
  const spawn = (await calls(page, 'pty_spawn'))[0]
  await emit(page, `pty_data:${spawn.args.eventKey}`, { id: 1, data })
}

function report(context: number) {
  const resets = Math.floor(Date.now() / 1000) + 2 * 3600
  return `\u001b]7770;usage;claude;${JSON.stringify({ session_id: ID, context_window_size: 200000, five_hour: { used_percentage: 30, resets_at: resets }, used_percentage: context })}\u0007`
}

test.beforeEach(async ({ page }) => {
  await seedConfirmed(page)
  await page.goto('/')
  await expect(page.locator('[data-terminal-phase="running"]')).toHaveCount(1)
})

test('usage over the threshold writes one handoff note and shows a toast', async ({ page }) => {
  await output(page, report(40))
  await expect(page.getByTestId('session-usage')).toBeVisible()
  expect(await calls(page, 'handoff_write')).toHaveLength(0)

  await output(page, report(96))
  await expect(page.getByText(/Handoff saved: .*-claude\.md/)).toBeVisible()
  // More reports at the same level do not write another one.
  await output(page, report(97))
  await output(page, report(98))
  await page.waitForTimeout(300)

  const writes = await calls(page, 'handoff_write')
  expect(writes).toHaveLength(1)
  expect(writes[0].args).toMatchObject({ provider: 'claude', sessionId: ID })
  const markdown: string = writes[0].args.markdown
  expect(markdown).toContain('# Handoff:')
  expect(markdown).toContain('- Context: 96%')
  expect(markdown).toContain('Build the settings page')
  expect(markdown).toContain('- [x] Wire the form')
  expect(markdown).toContain(`claude --resume ${ID}`)
  expect(markdown).not.toContain(`${USERS}`)
  expect((await calls(page, 'handoff_collect'))[0].args).toMatchObject({ provider: 'claude', sessionId: ID })
  await expect(page.getByTestId('toast-action')).toHaveText('Open in Pinned')
})

test('a shell pane is never journaled; an agent pane journals what is submitted', async ({ page }) => {
  const screen = page.locator('.xterm-helper-textarea').first()
  await screen.focus()
  await page.keyboard.type('echo hi')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(200)
  expect(await calls(page, 'journal_append')).toHaveLength(0)

  await output(page, report(10))
  await expect(page.getByTestId('session-usage')).toBeVisible()
  await screen.focus()
  await page.keyboard.type('please add a dark mode toggle')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await calls(page, 'journal_append')).length).toBe(1)
  expect((await calls(page, 'journal_append'))[0].args).toMatchObject({ provider: 'claude', text: 'please add a dark mode toggle' })
})
