import { test, expect, seedConfirmed, emit } from './helpers'
import type { Page } from '@playwright/test'

// Code-7xc.3: Cmd+F finds in the focused terminal pane with every match
// highlighted, Cmd+Shift+F searches all panes, and conversations mark matches
// in place instead of only hiding turns. Chromium + mock IPC.

const calls = (page: Page, cmd: string) => page.evaluate(name => (window as any).__bsInvokeLog.filter((e: any) => e.cmd === name), cmd)

async function openShell(page: Page) {
  await seedConfirmed(page)
  await page.goto('/')
  await expect(page.locator('[data-terminal-phase="running"]')).toHaveCount(1)
}
async function output(page: Page, data: string) {
  const spawn = (await calls(page, 'pty_spawn'))[0]
  await emit(page, `pty_data:${spawn.args.eventKey}`, { id: 1, data })
}

test('Cmd+F highlights every match in the pane, Enter steps, Escape closes and returns to the terminal', async ({ page }) => {
  await openShell(page)
  await output(page, 'alpha needle one\r\nbeta\r\nneedle two NEEDLE three\r\n')
  await expect.poll(() => page.locator('[data-terminal-pane] .xterm-rows').innerText()).toContain('NEEDLE three')
  await page.locator('[data-terminal-pane] .xterm-helper-textarea').first().focus()

  await page.keyboard.press('Meta+f')
  const input = page.getByTestId('find-input')
  await expect(input).toBeFocused()
  await input.fill('needle')
  await expect(page.getByTestId('find-count')).toHaveText('1 / 3')
  // Decorations are drawn as elements over the screen: all matches, one stronger.
  await expect.poll(() => page.locator('[data-terminal-pane] .xterm-decoration').count()).toBeGreaterThanOrEqual(3)

  await page.keyboard.press('Enter')
  await expect(page.getByTestId('find-count')).toHaveText('2 / 3')
  await page.keyboard.press('Shift+Enter')
  await expect(page.getByTestId('find-count')).toHaveText('1 / 3')
  await page.keyboard.press('Shift+Enter')
  await expect(page.getByTestId('find-count')).toHaveText('3 / 3')

  await page.getByRole('button', { name: 'Match case' }).click()
  await input.fill('NEEDLE')
  await expect(page.getByTestId('find-count')).toHaveText('1 / 1')
  await page.getByRole('button', { name: 'Regular expression' }).click()
  await input.fill('(')
  await expect(page.getByTestId('find-count')).not.toHaveText(/\d \/ \d/)
  await expect(page.getByTestId('find-bar')).toBeVisible()

  // Escape stays inside the bar: nothing is sent to the shell.
  const writesBefore = (await calls(page, 'pty_write')).length
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('find-bar')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(true)
  expect((await calls(page, 'pty_write')).length).toBe(writesBefore)
  await expect.poll(() => page.locator('[data-terminal-pane] .xterm-decoration').count()).toBe(0)
})

test('Cmd+Shift+F lists matches across panes and a click jumps to the match', async ({ page }) => {
  await openShell(page)
  const lines = Array.from({ length: 120 }, (_, i) => (i === 10 ? 'the rare zebra line' : `filler ${i}`)).join('\r\n')
  await output(page, `${lines}\r\n`)
  await expect.poll(() => page.locator('[data-terminal-pane] .xterm-rows').innerText()).toContain('filler 119')
  await page.keyboard.press('Meta+Shift+f')
  await page.getByTestId('find-input').fill('zebra')
  await expect(page.getByTestId('find-group')).toHaveCount(1)
  await expect(page.getByTestId('find-results').locator('mark')).toHaveText('zebra')
  await page.getByTestId('find-results').getByRole('option').first().click()
  await expect(page.getByTestId('find-bar')).toHaveCount(0)
  await expect.poll(() => page.locator('[data-terminal-pane] .xterm-rows').innerText()).toContain('the rare zebra line')
})

test('a restored conversation marks matches in context and steps through them', async ({ page }) => {
  await seedConfirmed(page)
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    localStorage.setItem('beads-station.session-preferences', JSON.stringify({ chatSurface: 'terminal' }))
    localStorage.setItem('beads-station.termPanes', JSON.stringify({ v: 2, projects: { 'proj-a': {
      tabs: [{ id: 'tab900', activePaneId: 'pane901', root: { kind: 'leaf', paneId: 'pane901', ptyId: 3, cwd: '/tmp/sample-project', agentCli: 'claude', agentSessionId: 'aaaa1111-0000-4000-8000-000000000001',
        savedScreen: { lines: ['> old screen'], cols: 80, rows: 24, buffer: 'alternate', cursorX: 0, cursorY: 0, capturedAt: Date.now() - 3_600_000 } } }],
      activeTabId: 'tab900', insert: false } } }))
  })
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  const pane = page.locator('[data-restored-pane="pane901"]')
  await expect(pane.getByTestId('restored-conversation')).toContainText('Fix the header spacing')
  const turnsAll = await pane.locator('article').count()

  // Cmd+F focuses the conversation's own search box.
  await page.keyboard.press('Meta+f')
  const search = pane.getByLabel('Search this conversation')
  await expect(search).toBeFocused()
  await search.fill('header')
  await expect(pane.locator('mark.bs-find-mark').first()).toBeVisible()
  expect(await pane.locator('mark.bs-find-mark').count()).toBeGreaterThanOrEqual(2)
  // Turns stay visible by default; the filter is opt-in.
  await expect(pane.locator('article')).toHaveCount(turnsAll)
  await expect(pane.getByTestId('conversation-find-count')).toHaveText(/^1 \/ \d+$/)
  await page.keyboard.press('Enter')
  await expect(pane.getByTestId('conversation-find-count')).toHaveText(/^2 \/ \d+$/)
  await expect(pane.locator('mark.bs-find-mark--active')).toHaveCount(1)

  await search.fill('zebra')
  await expect(pane.getByText(/Nothing in this conversation matches/)).toBeVisible()
  await search.fill('Fix the header')
  await pane.getByLabel('Only matching turns').check()
  await expect(pane.locator('article')).toHaveCount(1)
})
