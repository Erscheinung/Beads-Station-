import { test, expect, seedConfirmed, emit } from './helpers'

// Sounds are synthesized with Web Audio; the page's AudioContext is stubbed so
// the test sees every oscillator started. Real audio output is a hands-on check.

test.beforeEach(async ({ page }) => {
  await seedConfirmed(page)
  await page.addInitScript(() => {
    ;(window as any).__oscStarts = 0
    class Ctx {
      state = 'running'; currentTime = 0; destination = {}
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} } }
      createOscillator() { return { frequency: {}, connect() {}, start() { (window as any).__oscStarts++ }, stop() {} } }
    }
    ;(window as any).AudioContext = Ctx
  })
  await page.goto('/')
  await expect(page.locator('[data-terminal-phase="running"]')).toHaveCount(1)
})

const starts = (page: import('@playwright/test').Page) => page.evaluate(() => (window as any).__oscStarts as number)

async function openSounds(page: import('@playwright/test').Page) {
  await page.getByTitle('Open settings', { exact: true }).click()
  await page.getByRole('button', { name: 'Notifications', exact: true }).click()
}

test('preview plays the chosen sound and the event switch is saved', async ({ page }) => {
  await openSounds(page)
  await page.getByLabel('Preview sound: Subagent finished', { exact: true }).click()
  await expect.poll(() => starts(page)).toBeGreaterThan(0)

  const waiting = page.getByLabel('Sound: Waiting for you', { exact: true })
  await expect(waiting).toBeChecked()
  await expect(page.getByLabel('Sound: Subagent finished', { exact: true })).not.toBeChecked()
  await page.getByLabel('Sound: Subagent finished', { exact: true }).check()
  await page.getByLabel('Sound choice: Subagent finished', { exact: true }).selectOption('bell')

  await page.reload()
  await openSounds(page)
  await expect(page.getByLabel('Sound: Subagent finished', { exact: true })).toBeChecked()
  await expect(page.getByLabel('Sound choice: Subagent finished', { exact: true })).toHaveValue('bell')
})

test('a background pane that needs the user plays a sound, a disabled event does not', async ({ page }) => {
  await page.getByRole('button', { name: 'Split right', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(() => (window as any).__bsInvokeLog.filter((e: any) => e.cmd === 'pty_spawn').length))).toBe(2)
  const spawn = await page.evaluate(() => (window as any).__bsInvokeLog.filter((e: any) => e.cmd === 'pty_spawn')[0])
  const before = await starts(page)
  await emit(page, `pty_data:${spawn.args.eventKey}`, { id: 1, data: '\u001b]777;notify;Claude Code;Subagent finished\u0007' })
  await page.waitForTimeout(300)
  expect(await starts(page)).toBe(before)
  await emit(page, `pty_data:${spawn.args.eventKey}`, { id: 2, data: '\u001b]777;notify;Claude Code;Claude needs your permission to use Bash\u0007' })
  await expect.poll(() => starts(page)).toBeGreaterThan(before)
})
