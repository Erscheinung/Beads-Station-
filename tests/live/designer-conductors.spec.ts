import { test, expect } from '@playwright/test'

// Code-da0.5 — Designer ticket runs can route through the Codex adaptive
// orchestrator or the Opus conductor; a backend that is not installed is
// listed but cannot be chosen.

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

test('lists conductor backends and disables one that is not installed', async ({ page }) => {
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

test('starts a ticket run through the Opus conductor when its skill is installed', async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as any).__bsMockOverride = {
      native_provider_status: [
        { provider: 'claude', available: true, executable: '/usr/local/bin/claude', detail: 'Installed; login is managed by the native CLI' },
        { provider: 'codex', available: false, executable: null, detail: 'codex not found' },
        { provider: 'codex-orchestrator', available: false, executable: null, detail: 'Requires Codex: codex not found' },
        { provider: 'opus-conductor', available: true, executable: '/usr/local/bin/claude', detail: 'Opus plans, Sonnet workers implement, Haiku reads; skill at ~/.claude/skills/adaptive-orchestrator/SKILL.md' },
      ],
    }
  })
  await openTicket(page)
  const select = page.locator('#designer-provider')
  await expect(select.locator('option[value="opus-conductor"]')).toBeEnabled()
  await select.selectOption('opus-conductor')
  await expect(page.getByText(/Opus plans, Sonnet workers implement/)).toBeVisible()
  expect(await page.evaluate(() => (window as any).__bsInvokeLog.some((entry: any) => entry.cmd === 'native_run_start'))).toBe(false)
  await page.getByRole('button', { name: 'Start work', exact: true }).click()
  await expect.poll(async () => page.evaluate(() => {
    const call = (window as any).__bsInvokeLog.find((entry: any) => entry.cmd === 'native_run_start')
    return call?.args?.provider ?? null
  })).toBe('opus-conductor')
})
