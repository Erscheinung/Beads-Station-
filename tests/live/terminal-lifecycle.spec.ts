import { test, expect, boot, leader, invokeLog } from './helpers'

test('collapse, expand and project round-trip do not replace a terminal session', async ({ page }) => {
  await boot(page)
  await expect(page.locator('[data-terminal-phase="running"]')).toHaveCount(1)
  const initial = (await invokeLog(page)).filter(e => e.cmd === 'pty_spawn')
  expect(initial).toHaveLength(1)
  const collapse = page.getByRole('button', { name: /terminal ·/ })
  await collapse.click()
  await expect(page.locator('[data-terminal-pane]')).toHaveCount(0)
  await collapse.click()
  await expect(page.locator('[data-terminal-phase="running"]')).toHaveCount(1)
  expect((await invokeLog(page)).filter(e => e.cmd === 'pty_spawn')).toHaveLength(1)
  await leader(page)
  await page.keyboard.press('p')
  await expect(page.locator('.bs-tab--active')).toHaveText('Nexus')
  await expect(page.locator('[data-terminal-phase="running"]')).toHaveCount(1)
  await leader(page)
  await page.keyboard.press('p')
  await expect(page.locator('.bs-tab--active')).toHaveText('Beads-Station')
  expect((await invokeLog(page)).filter(e => e.cmd === 'pty_spawn')).toHaveLength(2)
})

