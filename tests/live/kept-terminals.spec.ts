import { test, expect, boot } from './helpers'

// Code-6un.3 — with "Keep terminals running" on, a pane's shell is requested
// from the terminal host under a key that survives a reload, so the next
// launch asks for the same shell instead of a new one.

const spawns = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as any).__bsInvokeLog.filter((entry: any) => entry.cmd === 'pty_spawn').map((entry: any) => entry.args.persistKey ?? null))

test('a pane asks for the same kept shell again after a reload, and an ordinary one by default', async ({ page }) => {
  await boot(page)
  await expect.poll(() => spawns(page)).toEqual([null])

  await page.evaluate(() => localStorage.setItem('beads-station.session-preferences', JSON.stringify({ keepTerminalsRunning: true })))
  await page.reload()
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  await expect.poll(async () => (await spawns(page)).length).toBe(1)
  const [key] = await spawns(page)
  expect(key).toMatch(/^[0-9a-f-]{36}$/)
  expect(await page.evaluate(() => (window as any).__bsInvokeLog.some((entry: any) => entry.cmd === 'pty_set_keep_running' && entry.args.keep === true))).toBe(true)

  await page.reload()
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  await expect.poll(() => spawns(page)).toEqual([key])
})
