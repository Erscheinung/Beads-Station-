import { test, expect, boot } from './helpers'

// Phase 9 (Code-ky4.9) — command palette live-verify.
// Boots the primary shell (browser-mock), drives Cmd+K, and asserts each
// command reaches the right seam: bd_claim / bd_create fired with the right
// args, grep dispatches issue:open, toggle flips the .du-theme class, Esc closes.

async function openPalette(page: import('@playwright/test').Page): Promise<void> {
  await page.keyboard.press('Meta+k')
  await expect(page.locator('.bs-palette [cmdk-input]')).toBeVisible()
}

test('Cmd+K opens the palette and Esc closes it', async ({ page }) => {
  await boot(page)
  await openPalette(page)
  await expect(page.getByText('Switch project')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.bs-palette [cmdk-input]')).toHaveCount(0)
})

test('grep filters issues and selecting one dispatches issue:open', async ({ page }) => {
  await boot(page)
  // Hook issue:open before opening so we can assert the dispatch.
  await page.evaluate(() => {
    ;(window as any).__lastIssueOpen = null
    window.addEventListener('issue:open', (e: Event) => {
      ;(window as any).__lastIssueOpen = (e as CustomEvent).detail
    })
  })
  await openPalette(page)
  await page.getByText('Search beads / issue explorer').click()
  // cmdk fuzzy-filters the issue list; type part of a known fixture title.
  await page.locator('.bs-palette [cmdk-input]').fill('beta')
  await page.getByText('Code-bbb · ready beta').click()
  await expect
    .poll(() => page.evaluate(() => (window as any).__lastIssueOpen?.id))
    .toBe('Code-bbb')
})

test('Claim ready fires bd_claim with the chosen id', async ({ page }) => {
  await boot(page)
  await openPalette(page)
  await page.getByText('Claim ready').click()
  await page.getByText('Code-aaa · ready alpha').click()
  await expect
    .poll(async () => {
      const log = await page.evaluate(() => (window as any).__bsInvokeLog ?? [])
      return log.some(
        (e: { cmd: string; args?: Record<string, unknown> }) =>
          e.cmd === 'bd_claim' && e.args?.id === 'Code-aaa',
      )
    })
    .toBe(true)
})

test('New issue fires bd_create with the typed title', async ({ page }) => {
  await boot(page)
  await openPalette(page)
  await page.getByText('New issue').click()
  await page.locator('.bs-palette [cmdk-input]').fill('palette-made task')
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => {
      const log = await page.evaluate(() => (window as any).__bsInvokeLog ?? [])
      return log.some(
        (e: { cmd: string; args?: Record<string, unknown> }) =>
          e.cmd === 'bd_create' && e.args?.title === 'palette-made task',
      )
    })
    .toBe(true)
})

test('Toggle theme updates document colors, including portaled menus', async ({ page }) => {
  await boot(page)
  const before = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bs-bg'))
  await openPalette(page)
  await page.getByText('Toggle theme').click()
  await expect
    .poll(() =>
      page.evaluate(
        () => getComputedStyle(document.documentElement).getPropertyValue('--bs-bg'),
      ),
    )
    .not.toBe(before)
  await openPalette(page)
  await expect(page.locator('.bs-palette')).toHaveCSS('background-color', 'rgb(239, 239, 240)')
})
