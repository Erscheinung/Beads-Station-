import { test, expect } from '@playwright/test'

// Code-da0.5 — Designer ticket runs can route through the Codex adaptive
// orchestrator; the Opus conductor is listed as a disabled placeholder.

async function openTicket(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('beads-station.workspaces.v2', JSON.stringify({ openIds: ['proj-a'], activeId: 'proj-a' }))
  })
  await page.goto('/?ui=designer')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  await page.getByRole('button', { name: 'Bead graph', exact: true }).click()
  await page.locator('[data-bs-bead-node][data-bs-bead-state="ready"]').first().click()
  await expect(page.getByTestId('designer-ticket-run')).toBeVisible()
}

test('lists conductor backends and disables the Opus placeholder', async ({ page }) => {
  await openTicket(page)
  const select = page.locator('#designer-provider')
  await expect(select.locator('option[value="codex-orchestrator"]')).toBeEnabled()
  await expect(select.locator('option[value="opus-conductor"]')).toBeDisabled()
  // Availability is re-read for the active workspace so a repo-local skill counts.
  await expect.poll(async () => page.evaluate(() => (window as any).__bsInvokeLog
    .some((entry: any) => entry.cmd === 'native_provider_status' && typeof entry.args?.cwd === 'string'))).toBe(true)
})

test('starts a ticket run through the Codex orchestrator only on explicit Start', async ({ page }) => {
  await openTicket(page)
  await page.locator('#designer-provider').selectOption('codex-orchestrator')
  await expect(page.getByText(/Sol plans, Luna workers implement/)).toBeVisible()
  expect(await page.evaluate(() => (window as any).__bsInvokeLog.some((entry: any) => entry.cmd === 'native_run_start'))).toBe(false)
  await page.getByRole('button', { name: 'Start work', exact: true }).click()
  await expect.poll(async () => page.evaluate(() => {
    const call = (window as any).__bsInvokeLog.find((entry: any) => entry.cmd === 'native_run_start')
    return call?.args?.provider ?? null
  })).toBe('codex-orchestrator')
})
