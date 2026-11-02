import { test, expect, boot } from './helpers'

// Hands-on 0.1.6 reports: keyboard pane focus, tab dragging, seams over a page, closing.

test.beforeEach(async ({ page }) => { await boot(page) })

const focusedPane = (page: import('@playwright/test').Page) => page.evaluate(() => document.activeElement?.closest('[data-terminal-pane]')?.getAttribute('data-terminal-pane') ?? null)

test('keyboard focus moves the real input to the neighbouring pane', async ({ page }) => {
  await page.getByRole('button', { name: 'Split right', exact: true }).click()
  await expect(page.locator('[data-terminal-pane]')).toHaveCount(2)
  await expect.poll(() => focusedPane(page)).not.toBeNull()
  const right = await focusedPane(page)
  await page.keyboard.press('Meta+Shift+ArrowLeft')
  await expect.poll(() => focusedPane(page)).not.toBe(right)
  await page.keyboard.press('Meta+Shift+ArrowRight')
  await expect.poll(() => focusedPane(page)).toBe(right)
})

test('unsplit can be undone with Join tabs, keeping every pane', async ({ page }) => {
  await page.getByRole('button', { name: 'Split right', exact: true }).click()
  await page.getByRole('button', { name: 'Unsplit to tabs', exact: true }).click()
  await expect(page.getByRole('tab', { name: /Terminal tab 2/ })).toBeVisible()
  await page.getByRole('button', { name: 'Join tabs', exact: true }).click()
  await expect(page.getByRole('tab', { name: /Terminal tab/ })).toHaveCount(0)
  await expect(page.locator('[data-terminal-pane]')).toHaveCount(2)
})

test('terminal tabs reorder by dragging with the pointer', async ({ page }) => {
  await page.getByRole('button', { name: 'Split right', exact: true }).click()
  await page.getByRole('button', { name: 'Unsplit to tabs', exact: true }).click()
  const tabs = page.locator('[data-terminal-tab]')
  await expect(tabs).toHaveCount(2)
  const order = () => tabs.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-terminal-tab')))
  const before = await order()
  await tabs.nth(0).dragTo(tabs.nth(1))
  expect(await order()).toEqual([...before].reverse())
})

test('a seam drag ends over a page, and the browser pane closes from its own bar', async ({ page }) => {
  await page.getByRole('button', { name: 'Browser', exact: true }).click()
  const pane = page.locator('[data-browser-pane]')
  await pane.getByLabel('Address').fill('localhost:1422/vite.svg')
  await pane.getByLabel('Address').press('Enter')
  await expect(pane.locator('iframe')).toBeVisible()

  const seam = page.locator('[data-bs-split-seam]').first()
  const box = (await seam.boundingBox())!
  await page.mouse.move(box.x + 1, box.y + 100)
  await page.mouse.down()
  await expect(page.locator('html.bs-dragging')).toHaveCount(1)
  await page.mouse.move(box.x + 120, box.y + 100, { steps: 4 })
  await page.mouse.up()
  await expect(page.locator('html.bs-dragging')).toHaveCount(0)
  const settled = (await seam.boundingBox())!
  await page.mouse.move(box.x - 150, box.y + 100, { steps: 4 })
  expect((await seam.boundingBox())!.x).toBe(settled.x)

  await pane.getByRole('button', { name: 'Close browser' }).click()
  await expect(pane).toHaveCount(0)
})

test('the toolbar starts an agent in a terminal pane rather than the chat panel', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('beads-station.session-preferences', JSON.stringify({ chatSurface: 'terminal', claudeCommand: 'claude --dangerously-skip-permissions' }))
  })
  await page.reload()
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  await page.getByRole('button', { name: 'Start Claude chat', exact: true }).click()
  await expect(page.locator('[data-terminal-pane]')).toHaveCount(2)
})

test('the chat panel has a close button that stops the chat', async ({ page }) => {
  await page.getByRole('button', { name: 'Close Claude chat' }).click()
  await expect(page.getByRole('button', { name: 'Start Claude chat', exact: true })).toBeEnabled()
  await expect.poll(() => page.evaluate(() => (window as any).__bsInvokeLog.some((entry: any) => entry.cmd === 'claude_kill'))).toBe(true)
})
