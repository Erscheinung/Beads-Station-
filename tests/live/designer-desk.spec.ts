import { test, expect } from '@playwright/test'

// Code-05b — Designer Desk: History reads agent sessions without starting
// anything, Resume is an explicit click, and the Shelf types without submitting.

async function openDesigner(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('beads-station.workspaces.v2', JSON.stringify({ openIds: ['proj-a'], activeId: 'proj-a' }))
  })
  await page.goto('/?ui=designer')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
}

const calls = (page: import('@playwright/test').Page, cmd: string) =>
  page.evaluate(name => (window as any).__bsInvokeLog.filter((entry: any) => entry.cmd === name), cmd)

test('History shows a formatted conversation without starting or resuming anything', async ({ page }) => {
  await openDesigner(page)
  await page.getByRole('button', { name: 'History', exact: true }).click()
  const history = page.getByTestId('designer-history')
  await expect(history.getByRole('button', { name: /Fix the header spacing/ })).toBeVisible()
  await history.getByRole('button', { name: /Fix the header spacing/ }).click()

  await expect(history.locator('[data-role="assistant"] .bs-md strong')).toHaveText('header')
  await expect(page.getByTestId('history-usage')).toContainText('1.5M cached')
  await history.getByText('Edit', { exact: true }).click()
  await expect(history.getByText('updated')).toBeVisible()

  await history.getByLabel('Search this conversation').fill('nothing like this')
  await expect(history.getByText('No turn matches that search.')).toBeVisible()

  expect((await calls(page, 'pty_spawn')).length).toBe(0)
})

test('Resume in Session starts a terminal only after the click', async ({ page }) => {
  await openDesigner(page)
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await page.getByRole('button', { name: /Fix the header spacing/ }).click()
  expect((await calls(page, 'pty_spawn')).length).toBe(0)

  await page.getByRole('button', { name: 'Resume in Session', exact: true }).click()
  await expect(page.locator('[data-terminal-pane="designer:proj-a"]')).toBeVisible()
  await expect.poll(async () => (await calls(page, 'pty_spawn')).length).toBe(1)
  // The resume command itself is typed once the shell prints a prompt, which the mock shell never does;
  // its text is pinned in deskLogic.test.ts and the typed step is on the native hands-on list.
})

test('the Shelf classifies input, pins from History, and types without pressing Enter', async ({ page }) => {
  await openDesigner(page)
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await page.getByRole('button', { name: /Fix the header spacing/ }).click()
  await page.getByRole('button', { name: 'Pin this to the Shelf' }).last().click()

  await page.getByRole('button', { name: 'Shelf', exact: true }).click()
  const shelf = page.getByTestId('designer-shelf')
  await expect(shelf.getByText('I tightened the **header** padding.')).toBeVisible()
  await shelf.getByLabel('Add to the shelf').fill('~/Documents/nAI/Plan.md')
  await shelf.getByRole('button', { name: 'Add to shelf', exact: true }).click()
  await expect(shelf.getByText('Note', { exact: true })).toBeVisible()
  // No session yet: nowhere to type.
  await expect(shelf.getByRole('button', { name: 'No running session to send to' })).toBeDisabled()

  await page.getByRole('button', { name: 'Session', exact: true }).click()
  await page.getByRole('button', { name: 'Plain shell', exact: true }).click()
  await expect.poll(async () => (await calls(page, 'pty_spawn')).length).toBe(1)
  await page.getByRole('button', { name: 'Shelf', exact: true }).click()
  await page.getByRole('button', { name: /^Type 2 into designer session$/ }).click()
  await expect(page.getByRole('status')).toContainText('Nothing was submitted.')
  // xterm turns pasted line breaks into \r; what must be absent is a final Enter.
  const data = (await calls(page, 'pty_write')).map((entry: any) => String(entry.args.data)).join('')
  expect(data).toContain('Plan.md')
  expect(data.endsWith('\r')).toBe(false)
})

test('the meter shows Codex windows against an even pace and does not start anything', async ({ page }) => {
  await openDesigner(page)
  await page.getByRole('button', { name: 'History', exact: true }).click()
  const meter = page.getByTestId('history-meter')
  await expect(meter.getByText('Codex 5-hour')).toBeVisible()
  await expect(meter.getByText('85%')).toBeVisible()
  await expect(meter.getByText(/ahead of even pace/)).toBeVisible()
  await expect(meter.getByText('Codex Weekly')).toBeVisible()
  await expect(meter.getByText('Claude output, 7 days')).toBeVisible()
  expect((await calls(page, 'pty_spawn')).length).toBe(0)
})

test('a ticket lists the sessions that worked it and opens one in History', async ({ page }) => {
  await openDesigner(page)
  await page.getByRole('button', { name: 'Bead map', exact: true }).click()
  await page.locator('[data-bs-bead-node][data-bs-bead-state="ready"]').first().dblclick()
  const sessions = page.getByTestId('ticket-sessions')
  await expect(sessions).toContainText('Sessions on this ticket')
  await expect(sessions.getByRole('button')).toHaveCount(1)
  await sessions.getByRole('button').click()
  await expect(page.getByTestId('designer-history').locator('[data-role="assistant"] .bs-md strong')).toHaveText('header')
  expect((await calls(page, 'pty_spawn')).length).toBe(0)
})
