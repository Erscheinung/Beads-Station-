import { test, expect, seedConfirmed } from './helpers'

test.beforeEach(async ({ page }) => {
  await seedConfirmed(page)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Start Claude chat', exact: true })).toBeVisible()
})

test('recipe settings creates and edits the deterministic review fixture', async ({ page }) => {
  await page.getByTitle('Open settings', { exact: true }).click()
  await page.getByRole('button', { name: 'Recipes', exact: true }).click()
  await page.getByRole('button', { name: 'Create Review workspace fixture', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Review workspace', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Review workspace', exact: true }).click()
  await expect(page.getByRole('list', { name: 'Steps for Review workspace' })).toContainText('workspace.select')
  await expect(page.getByRole('list', { name: 'Steps for Review workspace' })).toContainText('terminal.split')

  const binding = page.getByLabel('Shortcut binding for Review workspace', { exact: true })
  await binding.fill('Mod+Shift+R')
  await page.getByRole('button', { name: 'Save binding', exact: true }).click()
  await expect(binding).toHaveValue('Mod+Shift+R')

  await page.getByRole('button', { name: 'Start recording', exact: true }).click()
  await expect(page.locator('.bs-settings__recipe-status')).toContainText('Recording')
  await page.getByRole('button', { name: 'Stop and review', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Recorded recipe name', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
})
