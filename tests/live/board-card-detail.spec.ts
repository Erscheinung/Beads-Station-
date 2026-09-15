import { test, expect, boot } from './helpers'

test('double-clicking a board card opens its detail and actions', async ({ page }) => {
  await test.step('boot and show the board', async () => {
    await boot(page)
    await page.getByLabel('Beads view', { exact: true }).selectOption('board')
    await page.getByTitle('Fullscreen: Cmd/Ctrl+Shift+Enter', { exact: true }).click()
  })

  const card = page.locator('.bs-card').filter({ hasText: 'ready alpha' })
  await expect(card).toBeVisible()
  await card.dblclick()

  const detail = page.getByRole('dialog', { name: 'issue detail' })
  await expect(detail).toBeVisible()
  await expect(detail).toContainText('Code-aaa')
  await expect(detail).toContainText('ready alpha')
  await expect(detail.getByRole('button', { name: /Apply command/ })).toBeVisible()
})
