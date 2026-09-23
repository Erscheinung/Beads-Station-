import { test, expect } from './helpers'

// Code-da0.8 — Designer side columns resize by pointer and keyboard, clamp,
// reset on double-click, and survive a reload.

async function bootDesigner(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => { localStorage.setItem('beads-station.workspaces.v2', JSON.stringify({ openIds: ['proj-a'], activeId: 'proj-a' })) })
  await page.goto('/?ui=designer')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  await expect(page.locator('#root')).toBeVisible()
}

test('navigation and agents columns resize, clamp, reset and persist', async ({ page }) => {
  await bootDesigner(page)
  const left = page.getByRole('separator', { name: 'Resize navigation column' })
  const right = page.getByRole('separator', { name: 'Resize gates and agents panel' })
  await expect(left).toHaveAttribute('aria-valuenow', '220')
  await expect(right).toHaveAttribute('aria-valuenow', '280')

  const box = (await left.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 200)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + 200, { steps: 4 })
  await page.mouse.up()
  await expect(left).toHaveAttribute('aria-valuenow', '300')

  await right.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(right).toHaveAttribute('aria-valuenow', '296')
  for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowLeft')
  await expect(right).toHaveAttribute('aria-valuenow', '560')

  await page.reload()
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  await expect(page.getByRole('separator', { name: 'Resize navigation column' })).toHaveAttribute('aria-valuenow', '300')
  await expect(page.getByRole('separator', { name: 'Resize gates and agents panel' })).toHaveAttribute('aria-valuenow', '560')

  await page.getByRole('separator', { name: 'Resize navigation column' }).dblclick()
  await expect(page.getByRole('separator', { name: 'Resize navigation column' })).toHaveAttribute('aria-valuenow', '220')
})
