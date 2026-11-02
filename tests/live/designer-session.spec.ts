import { test, expect } from '@playwright/test'

// Code-gya.10 — Designer live session: the real CLI in a terminal plus the
// files the workspace has changed. Opening the view starts nothing.

async function openDesigner(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('beads-station.workspaces.v2', JSON.stringify({ openIds: ['proj-a'], activeId: 'proj-a' }))
  })
  await page.goto('/?ui=designer')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
}

const spawned = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as any).__bsInvokeLog.filter((entry: any) => entry.cmd === 'pty_spawn').length)

test('shows changed files without starting a process, and starts one only on request', async ({ page }) => {
  await openDesigner(page)
  await page.getByRole('button', { name: 'Session', exact: true }).click()
  const session = page.getByTestId('designer-session')
  await expect(session.getByText('2 files · +4 −1')).toBeVisible()
  expect(await spawned(page)).toBe(0)

  await session.getByRole('button', { name: /src\/app\.ts/ }).click()
  await expect(session.locator('pre')).toContainText('+more')

  await session.getByRole('button', { name: 'Plain shell', exact: true }).click()
  await expect(session.locator('[data-terminal-pane="designer:proj-a"]')).toBeVisible()
  await expect.poll(() => spawned(page)).toBe(1)
  await expect(session.getByRole('button', { name: 'End session', exact: true })).toBeVisible()

  // Leaving the view and coming back keeps the same shell.
  await page.getByRole('button', { name: 'Timeline', exact: true }).click()
  await page.getByRole('button', { name: 'Session', exact: true }).click()
  await expect(page.locator('[data-terminal-pane="designer:proj-a"]')).toBeVisible()
  expect(await spawned(page)).toBe(1)
})

test('a ticket can be handed to the session, which still waits for a click', async ({ page }) => {
  await openDesigner(page)
  await page.getByRole('button', { name: 'Bead map', exact: true }).click()
  await page.locator('[data-bs-bead-node][data-bs-bead-state="ready"]').first().dblclick()
  await page.getByRole('button', { name: 'Open in a live session', exact: true }).click()

  await expect(page.getByTestId('designer-session-ticket')).toBeVisible()
  expect(await spawned(page)).toBe(0)
  await page.getByRole('button', { name: 'Start Claude Code on it', exact: true }).click()
  await expect.poll(() => spawned(page)).toBe(1)
  await expect(page.getByTestId('designer-session-ticket')).toBeHidden()
})

test('a session ticket can be captured, approved and closed without leaving the session', async ({ page }) => {
  await openDesigner(page)
  await page.getByRole('button', { name: 'Bead map', exact: true }).click()
  await page.locator('[data-bs-bead-node][data-bs-bead-state="ready"]').first().dblclick()
  await page.getByRole('button', { name: 'Open in a live session', exact: true }).click()
  await page.getByRole('button', { name: 'Start Claude Code on it', exact: true }).click()

  const review = page.getByTestId('designer-session-review')
  await expect(review).toBeVisible()
  await expect(review.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0)
  await review.getByRole('button', { name: 'Capture for review', exact: true }).click()
  await expect(page.getByTestId('designer-session-revision')).toContainText('Captured 1 file')

  // Capture first records the attempt, then freezes the files for that attempt.
  const calls = await page.evaluate(() => (window as any).__bsInvokeLog
    .filter((entry: any) => entry.cmd === 'native_session_submit' || entry.cmd === 'artifact_capture')
    .map((entry: any) => [entry.cmd, entry.args?.attemptId ?? entry.args?.args?.attemptId]))
  expect(calls.map((call: string[]) => call[0])).toEqual(['native_session_submit', 'artifact_capture'])
  expect(calls[0][1]).toBe(calls[1][1])

  await review.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.getByTestId('designer-session-revision')).toContainText('approved')
  await review.getByRole('button', { name: 'Close ticket', exact: true }).click()
  await expect(review).toContainText('Ticket closed.')
  expect(await page.evaluate(() => (window as any).__bsInvokeLog.some((entry: any) => entry.cmd === 'bd_close'))).toBe(true)
})

test('requesting changes starts a new attempt, so the old capture cannot be approved', async ({ page }) => {
  await openDesigner(page)
  await page.getByRole('button', { name: 'Bead map', exact: true }).click()
  await page.locator('[data-bs-bead-node][data-bs-bead-state="ready"]').first().dblclick()
  await page.getByRole('button', { name: 'Open in a live session', exact: true }).click()
  await page.getByRole('button', { name: 'Start Claude Code on it', exact: true }).click()
  const review = page.getByTestId('designer-session-review')
  await review.getByRole('button', { name: 'Capture for review', exact: true }).click()
  await review.getByLabel('Requested changes').fill('Make the header smaller')
  await review.getByRole('button', { name: 'Request changes', exact: true }).click()
  await expect(page.getByTestId('designer-session-revision')).toHaveCount(0)
  await expect(review.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0)
  await expect(review.getByRole('button', { name: 'Capture for review', exact: true })).toBeVisible()
})

test('the Agents item shows the agents list instead of a placeholder', async ({ page }) => {
  await openDesigner(page)
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await expect(page.getByText('Coming in a later DU phase.')).toHaveCount(0)
})
