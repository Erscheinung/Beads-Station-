import { test, expect, seedConfirmed } from './helpers'

// "no beads db" in the status bar is a button that opens Initialize Beads, and a
// folder can be told to stop showing it.
test.beforeEach(async ({ page }) => {
  await seedConfirmed(page)
  await page.addInitScript(() => {
    ;(window as any).__bsMockOverride = { bd_snapshot: { ready: [], all: [], no_db: true } }
  })
})

test('the status bar button opens Initialize Beads and can be dismissed for the folder', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  const button = page.getByRole('button', { name: 'no beads db · set up' })
  await expect(button).toBeVisible()
  await button.click()
  const popover = button.locator('xpath=..')
  await expect(popover.getByRole('region', { name: 'Initialize Beads' })).toBeVisible()
  await popover.getByRole('button', { name: 'Initialize Beads', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__bsInvokeLog.filter((e: any) => e.cmd === 'bd_initialize').length)).toBe(1)

  await page.getByRole('button', { name: 'Don’t show for this folder' }).click()
  await expect(page.getByRole('button', { name: 'no beads db · set up' })).toHaveCount(0)
  // Remembered across a reload (same folder), kept per path.
  await page.reload()
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  await expect(page.getByRole('button', { name: 'no beads db · set up' })).toHaveCount(0)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('beads-station.beads-setup-dismissed.v1') ?? '[]').length)).toBe(1)
})
