import { test, expect, boot } from './helpers'

// Code-470 — a web page beside the terminal. The page is a sandboxed iframe;
// sites that refuse framing go to a separate window.

test.beforeEach(async ({ page }) => { await boot(page) })

test('a browser pane loads a typed address in a sandboxed frame and keeps the shell running', async ({ page }) => {
  const spawned = () => page.evaluate(() => (window as any).__bsInvokeLog.filter((entry: any) => entry.cmd === 'pty_spawn').length)
  const before = await spawned()
  await page.getByRole('button', { name: 'Browser', exact: true }).click()
  const pane = page.locator('[data-browser-pane]')
  await expect(pane).toBeVisible()
  await expect(pane.locator('iframe')).toHaveCount(0)

  await pane.getByLabel('Address').fill('not a url with spaces')
  await pane.getByRole('button', { name: 'Go', exact: true }).click()
  await expect(pane.getByRole('alert')).toContainText('Enter a web address')

  await pane.getByLabel('Address').fill('localhost:1422/vite.svg')
  await pane.getByLabel('Address').press('Enter')
  const frame = pane.locator('iframe')
  await expect(frame).toHaveAttribute('src', 'http://localhost:1422/vite.svg')
  // The framed page can never navigate the app window itself.
  expect(await frame.getAttribute('sandbox')).not.toContain('allow-top-navigation')
  // Opening a browser pane starts no shell and stops none.
  expect(await spawned()).toBe(before)
  await expect(page.locator('[data-terminal-pane]')).toHaveCount(1)

  await pane.getByRole('button', { name: 'Window', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__bsInvokeLog.find((entry: any) => entry.cmd === 'browser_open_window')?.args?.url)).toBe('http://localhost:1422/vite.svg')
})
