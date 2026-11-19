import { test, expect, seedConfirmed } from './helpers'

// Many workspaces overflow the tab strip: a chevron lists all of them.
const projects = (count: number) => Array.from({ length: count }, (_, i) => ({
  id: `ws-${i}`, name: `Workspace number ${i}`, path: `/tmp/ws-${i}`, hasGit: false, hasBeads: false, claudeSessionId: '',
}))

async function boot(page: import('@playwright/test').Page, count: number) {
  await seedConfirmed(page)
  await page.addInitScript((list) => {
    localStorage.setItem('beads-station.workspaces.v2', JSON.stringify({ openIds: list.map(p => p.id), activeId: list[0].id }))
    ;(window as any).__bsMockOverride = { projects_list: { projects: list, roots: ['/tmp'], warnings: [] } }
  }, projects(count))
  await page.setViewportSize({ width: 1000, height: 700 })
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  await expect(page.locator('.bs-tabstrip .bs-tab').first()).toBeVisible()
}

test('with many workspaces a chevron lists them all and switches', async ({ page }) => {
  await boot(page, 12)
  const chevron = page.getByRole('button', { name: 'All workspaces (12)' })
  await expect(chevron).toBeVisible()
  await chevron.click()
  const menu = page.getByRole('menu', { name: 'Workspaces' })
  await expect(menu.getByRole('menuitemradio')).toHaveCount(12)
  await expect(menu.getByRole('menuitemradio', { name: /Workspace number 0$/ })).toHaveAttribute('aria-checked', 'true')
  await menu.getByRole('menuitemradio', { name: /Workspace number 11$/ }).click()
  await expect(menu).toHaveCount(0)
  const tab = page.locator('[data-workspace-tab="ws-11"]')
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await expect(tab).toBeInViewport()
  // The full name stays on the tab tooltip.
  await expect(tab).toHaveAttribute('title', /Workspace number 11\n\/tmp\/ws-11/)
})

test('no chevron with two workspaces', async ({ page }) => {
  await boot(page, 2)
  await expect(page.getByRole('button', { name: /All workspaces/ })).toHaveCount(0)
})
