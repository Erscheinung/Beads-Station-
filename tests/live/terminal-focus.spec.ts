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
