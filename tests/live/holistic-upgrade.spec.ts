import { test, expect, seedConfirmed } from './helpers'
import type { Page } from '@playwright/test'

// 0.2.1 holistic upgrade: restored agent panes read as conversations and
// continue with Enter, the shared top bar reaches every view and starts the
// three CLIs on a click only, and the palette finds views and conversations.

const SESSION = 'aaaa1111-0000-4000-8000-000000000001'

const log = (page: Page, cmd: string) =>
  page.evaluate(name => (window as any).__bsInvokeLog.filter((entry: any) => entry.cmd === name), cmd)

async function open(page: Page, seed: Record<string, unknown> = {}) {
  await seedConfirmed(page)
  await page.addInitScript((extra: Record<string, unknown>) => {
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    localStorage.setItem('beads-station.session-preferences', JSON.stringify({ chatSurface: 'terminal', geminiCommand: 'google', ...(extra.prefs as object ?? {}) }))
    if (extra.panes) localStorage.setItem('beads-station.termPanes', JSON.stringify(extra.panes))
  }, seed)
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  await expect(page.getByRole('navigation', { name: 'Views' })).toBeVisible()
}

const restoredClaudePane = {
  v: 2,
  projects: { 'proj-a': {
    tabs: [{ id: 'tab900', activePaneId: 'pane901', root: { kind: 'leaf', paneId: 'pane901', ptyId: 3, cwd: '/tmp/sample-project', agentCli: 'claude', agentSessionId: SESSION,
      savedScreen: { lines: ['> old screen'], cols: 80, rows: 24, buffer: 'alternate', cursorX: 0, cursorY: 0, capturedAt: Date.now() - 3_600_000 } } }],
    activeTabId: 'tab900', insert: false,
  } },
}

test('a restored Claude pane shows its conversation, searches it, and continues on Enter only', async ({ page }) => {
  await open(page, { panes: restoredClaudePane })
  const pane = page.locator('[data-restored-pane="pane901"]')
  await expect(pane.getByTestId('restored-conversation')).toContainText('Fix the header spacing')
  await expect(pane.locator('[data-role="assistant"] .bs-md strong')).toHaveText('header')
  await expect(pane.getByText('This pane’s conversation')).toBeVisible()
  // Reading started nothing.
  expect((await log(page, 'pty_spawn')).length).toBe(0)

  await pane.getByLabel('Search this conversation').fill('zebra')
  await expect(pane.getByText(/Nothing in this conversation matches/)).toBeVisible()
  await pane.getByLabel('Search this conversation').fill('')

  // The conversation scrolls inside the pane instead of growing it.
  const scroll = await pane.getByTestId('restored-conversation').evaluate(element => getComputedStyle(element).overflowY)
  expect(scroll).toBe('auto')

  await pane.getByRole('button', { name: 'Show saved screen' }).click()
  await expect(pane.getByLabel('Saved terminal screen')).toContainText('old screen')
  await pane.getByRole('button', { name: 'Show conversation' }).click()

  // The message box has the cursor; Enter is the explicit start.
  const box = pane.getByLabel('Message Claude to continue')
  await box.click()
  await box.press('Enter')
  await expect(page.locator('[data-terminal-pane="pane901"], [data-pane-id="pane901"], .xterm').first()).toBeVisible()
  await expect.poll(async () => (await log(page, 'pty_spawn')).length).toBe(1)
})

test('the saved screen wraps long lines and its last line is fully visible', async ({ page }) => {
  const long = 'x'.repeat(200)
  const pane901 = JSON.parse(JSON.stringify(restoredClaudePane))
  const leaf = pane901.projects['proj-a'].tabs[0].root
  leaf.savedScreen.lines = ['first line', long, ...Array.from({ length: 60 }, (_, i) => `row ${i}`), 'LAST LINE']
  await page.addInitScript(() => localStorage.setItem('beads-station.themePaletteId', 'fahrenheit'))
  await open(page, { panes: pane901 })
  const pane = page.locator('[data-restored-pane="pane901"]')
  await pane.getByRole('button', { name: 'Show saved screen' }).click()
  const scroller = pane.locator('.bs-saved-screen').last()
  await expect(scroller.getByLabel('Saved terminal screen')).toContainText('LAST LINE')
  const m = await scroller.evaluate(el => {
    el.scrollTop = el.scrollHeight
    const pre = el.querySelector('pre')!
    const range = document.createRange()
    range.selectNodeContents(pre)
    const rects = Array.from(range.getClientRects())
    const last = rects[rects.length - 1]
    const box = el.getBoundingClientRect()
    return { overflowX: el.scrollWidth - el.clientWidth, scrollbarH: el.offsetHeight - el.clientHeight, lastBottom: last.bottom, boxBottom: box.bottom - (el.offsetHeight - el.clientHeight) }
  })
  expect(m.overflowX).toBeLessThanOrEqual(0)
  expect(m.lastBottom).toBeLessThanOrEqual(m.boxBottom + 0.5)
})

test('with the opt-in setting, a restored pane whose conversation is known reopens by itself', async ({ page }) => {
  await open(page, { panes: restoredClaudePane, prefs: { autoResumeAgents: true } })
  await expect.poll(async () => (await log(page, 'pty_spawn')).length).toBe(1)
  await expect(page.locator('[data-restored-pane]')).toHaveCount(0)
})

test('the top bar reaches every Designer view from the Terminal and back with one key', async ({ page }) => {
  await open(page)
  const places = page.getByRole('navigation', { name: 'Views' })
  await expect(places.getByRole('button', { name: 'Terminal', exact: true })).toHaveAttribute('aria-pressed', 'true')

  // History is one click from the Terminal.
  await places.getByRole('button', { name: 'History', exact: true }).click()
  await expect(page.getByTestId('designer-history')).toBeVisible()
  await expect(page.getByTestId('designer-purpose')).toContainText('Read any past or running conversation')
  // It opens on the newest conversation instead of an empty page, and reading starts nothing.
  await expect(page.getByTestId('history-usage')).toBeVisible()

  await places.getByRole('button', { name: 'Pinned', exact: true }).click()
  await expect(page.getByTestId('pinned-empty')).toContainText('Nothing pinned yet')
  await page.getByTestId('pinned-empty').getByRole('button', { name: 'Open History' }).click()
  await expect(page.getByTestId('designer-history')).toBeVisible()

  // One chord each way; the Designer comes back on the view it was left on.
  await page.keyboard.press('Meta+Shift+D')
  await expect(places.getByRole('button', { name: 'Terminal', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Meta+Shift+D')
  await expect(page.getByTestId('designer-history')).toBeVisible()
  await page.keyboard.press('Meta+Shift+D')
  await page.keyboard.press('Meta+y')
  await expect(page.getByTestId('designer-history')).toBeVisible()
})

test('launchers start the configured command in a new pane, only on a click', async ({ page }) => {
  await open(page)
  const launchers = page.getByRole('group', { name: 'Start an agent in a new pane' })
  await expect(launchers.getByRole('button')).toHaveCount(3)
  const gemini = launchers.getByRole('button', { name: 'Start Gemini chat', exact: true })
  await expect(gemini).toHaveAttribute('title', /google/)
  const before = (await log(page, 'pty_spawn')).length
  const panesBefore = (await page.evaluate(() => (window as any).__bsTerm.paneCount)) as number
  await gemini.click()
  await expect.poll(() => page.evaluate(() => (window as any).__bsTerm.paneCount)).toBe(panesBefore + 1)
  await expect.poll(async () => (await log(page, 'pty_spawn')).length).toBe(before + 1)
  // No provider adapter was started behind the pane.
  expect((await log(page, 'claude_start')).length).toBe(0)
})

test('the palette finds Designer views and past conversations, and the cheat sheet lists shortcuts', async ({ page }) => {
  await open(page)
  await page.keyboard.press('Meta+k')
  const input = page.locator('[cmdk-input]')
  await input.fill('pinned')
  await page.locator('[cmdk-item]').filter({ hasText: 'Designer: Pinned context' }).click()
  await expect(page.getByTestId('designer-shelf')).toBeVisible()

  await page.keyboard.press('Meta+k')
  await input.fill('dark mode')
  await page.locator('[cmdk-item]').filter({ hasText: 'Add a dark mode toggle' }).click()
  await expect(page.getByTestId('designer-history')).toBeVisible()
  await expect(page.getByTestId('designer-history').getByRole('heading', { name: 'Add a dark mode toggle' })).toBeVisible()

  await page.keyboard.press('Meta+/')
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(sheet).toContainText('Switch between Terminal and Designer')
  await expect(sheet).toContainText('Focus terminal pane left (H)')
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
})
