import { test, expect } from './helpers'
import { boot } from './helpers'

// Code-qqt (RV1-focus) live-verify: fullscreen terminal focus toggle.
// Cmd/Ctrl+Enter maximizes the terminal region over the whole content area
// (Board stays mounted underneath) and toggles back. The region carries a
// data-terminal-focus attribute driven by App's terminalFocus state, and moves
// vim focus to the terminal on enter / back to the board on exit.

const region = '[data-terminal-focus]'

test.beforeEach(async ({ page }) => {
  await boot(page)
})

test('Cmd/Ctrl+Enter enters fullscreen terminal focus and moves vim focus there', async ({ page }) => {
  await expect(page.locator(region)).toHaveAttribute('data-terminal-focus', 'false')

  await page.keyboard.press('Control+Enter')

  await expect(page.locator(region)).toHaveAttribute('data-terminal-focus', 'true')
  await page.waitForFunction(() => (window as any).__bsVim?.focused === 'terminal')
})

test('Cmd/Ctrl+Enter again exits focus and restores board focus', async ({ page }) => {
  await page.keyboard.press('Control+Enter')
  await expect(page.locator(region)).toHaveAttribute('data-terminal-focus', 'true')

  await page.keyboard.press('Control+Enter')
  await expect(page.locator(region)).toHaveAttribute('data-terminal-focus', 'false')
  await page.waitForFunction(() => (window as any).__bsVim?.focused === 'board')
})

test('the terminal pane survives a focus enter/exit round-trip (no remount)', async ({ page }) => {
  // Record the live pane count before, toggle twice, assert it is unchanged —
  // a remount would drop/recreate panes and change the mirror.
  const before = await page.evaluate(() => (window as any).__bsTerm?.paneCount)
  await page.keyboard.press('Control+Enter')
  await expect(page.locator(region)).toHaveAttribute('data-terminal-focus', 'true')
  await page.keyboard.press('Control+Enter')
  await expect(page.locator(region)).toHaveAttribute('data-terminal-focus', 'false')
  const after = await page.evaluate(() => (window as any).__bsTerm?.paneCount)
  expect(after).toBe(before)
})

test('fullscreen promotes the terminal to the app canvas and hides unrelated chrome', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Claude chat running', exact: true })).toBeVisible()
  await page.waitForFunction(() => {
    const root = document.querySelector('[data-terminal-app-focus]') as HTMLElement | null
    return root !== null && getComputedStyle(root).gridTemplateRows.split(' ')[1] !== '0px'
  })
  const region = page.locator('[data-terminal-focus]')
  const pane = page.locator('[data-terminal-pane]').first()
  const beforeRegion = await region.boundingBox()
  if (!beforeRegion) throw new Error('terminal region is not visible')

  // Keep a DOM identity witness in the page. The visual mode changes around
  // the existing pane, so the retained xterm host must remain the same node.
  await pane.evaluate(el => { (window as any).__bsFullscreenPane = el })
  await page.keyboard.press('Control+Enter')

  await expect(page.locator('[data-terminal-app-focus]')).toHaveAttribute('data-terminal-app-focus', 'true')
  await expect(page.locator('.bs-toolbar')).toBeHidden()
  const appChrome = page.locator('main > .bs-app-chrome')
  await expect(appChrome).toHaveCount(2)
  await expect(appChrome.nth(0)).toBeHidden()
  await expect(appChrome.nth(1)).toBeHidden()
  await expect(page.locator('.bs-pane-actions')).toBeHidden()
  await expect(page.locator('.bs-app-statusline')).toBeHidden()

  const viewport = page.viewportSize()
  const focusedRegion = await region.boundingBox()
  if (!viewport || !focusedRegion) throw new Error('fullscreen terminal region is not visible')
  expect(Math.abs(focusedRegion.x)).toBeLessThan(1)
  expect(Math.abs(focusedRegion.y)).toBeLessThan(1)
  expect(Math.abs(focusedRegion.width - viewport.width)).toBeLessThan(1)
  expect(Math.abs(focusedRegion.height - viewport.height)).toBeLessThan(1)
  expect(await pane.evaluate(el => el === (window as any).__bsFullscreenPane)).toBe(true)

  await page.keyboard.press('Control+Enter')
  await expect(page.locator('[data-terminal-app-focus]')).toHaveAttribute('data-terminal-app-focus', 'false')
  const restoredRegion = await region.boundingBox()
  if (!restoredRegion) throw new Error('terminal region did not restore')
  expect(Math.abs(restoredRegion.x - beforeRegion.x)).toBeLessThan(1)
  expect(Math.abs(restoredRegion.y - beforeRegion.y)).toBeLessThan(1)
  expect(Math.abs(restoredRegion.width - beforeRegion.width)).toBeLessThan(1)
  await expect(page.locator('.bs-toolbar')).toBeVisible()
  await expect(page.locator('.bs-app-statusline')).toBeVisible()
  expect(await pane.evaluate(el => el === (window as any).__bsFullscreenPane)).toBe(true)
})
