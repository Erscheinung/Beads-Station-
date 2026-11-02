import { test, expect } from './helpers'
import { boot } from './helpers'

// Code-qqt (RV1-focus) live-verify: fullscreen terminal focus toggle.
// Cmd/Ctrl+Shift+Enter maximizes the terminal region over the whole content area
// (Board stays mounted underneath) and toggles back. The region carries a
// data-terminal-focus attribute driven by App's terminalFocus state, and moves
// vim focus to the terminal on enter / back to the board on exit.

const region = '[data-terminal-focus]'

test.beforeEach(async ({ page }) => {
  await boot(page)
})

test('Cmd/Ctrl+Shift+Enter enters fullscreen terminal focus and moves vim focus there', async ({ page }) => {
  await expect(page.locator(region)).toHaveAttribute('data-terminal-focus', 'false')

  await page.keyboard.press('Control+Shift+Enter')

  await expect(page.locator(region)).toHaveAttribute('data-terminal-focus', 'true')
  await page.waitForFunction(() => (window as any).__bsVim?.focused === 'terminal')
})

test('Cmd/Ctrl+Shift+Enter again exits focus and restores board focus', async ({ page }) => {
  await page.keyboard.press('Control+Shift+Enter')
  await expect(page.locator(region)).toHaveAttribute('data-terminal-focus', 'true')

  await page.keyboard.press('Control+Shift+Enter')
  await expect(page.locator(region)).toHaveAttribute('data-terminal-focus', 'false')
  await page.waitForFunction(() => (window as any).__bsVim?.focused === 'board')
})

test('the terminal pane survives a focus enter/exit round-trip (no remount)', async ({ page }) => {
  // Record the live pane count before, toggle twice, assert it is unchanged —
  // a remount would drop/recreate panes and change the mirror.
  const before = await page.evaluate(() => (window as any).__bsTerm?.paneCount)
  await page.keyboard.press('Control+Shift+Enter')
  await expect(page.locator(region)).toHaveAttribute('data-terminal-focus', 'true')
  await page.keyboard.press('Control+Shift+Enter')
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
  await page.keyboard.press('Control+Shift+Enter')

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

  await page.keyboard.press('Control+Shift+Enter')
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

test('directional tiling chords focus adjacent panes and resize their split', async ({ page }) => {
  await page.getByRole('button', { name: 'Split right', exact: true }).click()
  await expect(page.locator('[data-terminal-pane]')).toHaveCount(2)
  await expect(page.locator('[data-bs-split-seam]')).toHaveCount(1)

  const activePaneId = () => page.locator('[data-terminal-pane]').evaluateAll(nodes => {
    const active = nodes.find(node => (node.parentElement as HTMLElement | null)?.style.boxShadow)
    return active?.getAttribute('data-terminal-pane') ?? null
  })
  const paneIds = await page.locator('[data-terminal-pane]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-terminal-pane')))
  expect(paneIds).toHaveLength(2)
  expect(await activePaneId()).toBe(paneIds[1])

  // The default Mod+Shift+ArrowLeft focus command selects the geometric left
  // pane, even though the active pane started on the right side of the split.
  await page.keyboard.press('Meta+Shift+ArrowLeft')
  await expect.poll(activePaneId).toBe(paneIds[0])

  const firstHalfBasis = () => page.locator('[data-bs-split-seam]').evaluate(seam => {
    const firstHalf = seam.parentElement?.firstElementChild as HTMLElement | null
    return firstHalf?.style.flexBasis ?? ''
  })
  await expect.poll(firstHalfBasis).toBe('50%')

  // Shift adds resize semantics: left moves the seam one 5% step, while the
  // retained pane DOM/PTY identity remains unchanged.
  await page.keyboard.press('Control+Shift+ArrowLeft')
  await expect.poll(firstHalfBasis).toBe('45%')
  expect(await page.locator('[data-terminal-pane]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-terminal-pane')))).toEqual(paneIds)

  // The corresponding right chord restores the ratio, proving rebound-style
  // command routing reaches the same split store used by pointer resizing.
  await page.keyboard.press('Control+Shift+ArrowRight')
  await expect.poll(firstHalfBasis).toBe('50%')
})

// Code-gya.1: in the terminal-only view the region is a flex item. xterm gives
// its screen a pixel height, so without min-height:0 the region could not
// shrink and the bottom rows sat under the statusline until a fullscreen trip.
test('terminal-only view keeps the pane above the statusline when the window shrinks', async ({ page }) => {
  await page.getByLabel('Beads view').selectOption('terminal-only')
  const pane = page.locator('[data-terminal-pane]').first()
  await expect(pane).toBeVisible()
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('no viewport')
  await page.waitForFunction(() => document.querySelector('.xterm-screen') !== null)

  await page.setViewportSize({ width: viewport.width, height: viewport.height - 220 })

  await expect.poll(async () => {
    const paneBox = await pane.boundingBox()
    const status = await page.locator('.bs-app-statusline').boundingBox()
    const screen = await page.locator('.xterm-screen').first().boundingBox()
    if (!paneBox || !status || !screen) return Number.POSITIVE_INFINITY
    return Math.max(paneBox.y + paneBox.height, screen.y + screen.height) - status.y
  }).toBeLessThanOrEqual(1)
})
