import { test, expect, seedConfirmed } from './helpers'

test('a dev profile with Board-only and collapsed Explorer has an obvious restore path', async ({ page }) => {
  await seedConfirmed(page)
  await page.addInitScript(() => {
    if (!localStorage.getItem('sidebar-recovery-seeded')) {
      localStorage.setItem('beads-station.ui-preferences', JSON.stringify({
        view: 'board',
        sidebarCollapsed: true,
      }))
      localStorage.setItem('sidebar-recovery-seeded', 'true')
    }
  })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Show Explorer', exact: true })).toBeVisible()
  await expect(page.locator('aside')).toBeHidden()

  await page.getByRole('button', { name: 'Show Explorer', exact: true }).click()
  await expect(page.locator('aside')).toBeVisible()
  await expect(page.getByLabel('Beads view', { exact: true })).toHaveValue('explorer')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('beads-station.ui-preferences')!).sidebarCollapsed)).toBe(false)

  // The choice is persisted for this profile and survives a reload.
  await page.reload()
  await expect(page.getByLabel('Beads view', { exact: true })).toHaveValue('explorer')
  await expect(page.locator('aside')).toBeVisible()
})
