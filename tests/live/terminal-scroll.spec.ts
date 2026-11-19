import { test, expect, seedConfirmed, emit } from './helpers'
import type { Page } from '@playwright/test'

// Code-7xc.5: a reader scrolled up in a plain shell or an Ink CLI (Gemini)
// must stay put while the program redraws, answers focus changes, or clears
// and reprints its transcript, and while the pane moves between tabs; and it
// must be able to wheel back to the very bottom and follow again. Chromium +
// mock IPC with xterm's DOM renderer, so the visible rows are readable text.
// Packaged WKWebView scrolling is in the hands-on checklist.

const LINES = 300
const line = (n: number) => `L${String(n).padStart(4, '0')} transcript line`
const transcript = (count: number) => Array.from({ length: count }, (_, i) => line(i + 1)).join('\r\n')
// Ink keeps a live frame at the bottom and redraws it in place.
const frame = (tick: number) => `\r\n\x1b[2K* thinking ${tick}\r\n\x1b[2K> prompt`
const redraw = (tick: number) => `\r\x1b[1A\x1b[2K* thinking ${tick}\r\n\x1b[2K> prompt`
// Ink's full re-render: clear screen and scrollback, then reprint everything.
const reprint = (count: number, tick: number) => `\x1b[2J\x1b[3J\x1b[H${transcript(count)}${frame(tick)}`

test.beforeEach(async ({ page }) => {
  await seedConfirmed(page)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Start Claude chat', exact: true })).toBeVisible()
  await expect(page.locator('[data-terminal-phase="running"]')).toHaveCount(1)
})

const calls = (page: Page, cmd: string) => page.evaluate(name => (window as any).__bsInvokeLog.filter((e: any) => e.cmd === name), cmd)

async function output(page: Page, shell: number, data: string) {
  const spawn = (await calls(page, 'pty_spawn'))[shell]
  await emit(page, `pty_data:${spawn.args.eventKey}`, { id: 1, data })
}

/** The transcript line numbers visible in a pane, top to bottom. */
function visibleLines(page: Page, pane = 0): Promise<number[]> {
  return page.locator('[data-terminal-pane] .xterm-rows').nth(pane).evaluate(rows =>
    Array.from(rows.children).map(row => /L(\d{4})/.exec(row.textContent ?? '')?.[1]).filter(Boolean).map(Number))
}
const topLine = async (page: Page, pane = 0) => (await visibleLines(page, pane))[0] ?? -1
const rowsText = (page: Page, pane = 0) => page.locator('[data-terminal-pane] .xterm-rows').nth(pane).innerText()

async function wheel(page: Page, deltaY: number, pane = 0) {
  const box = await page.locator('[data-terminal-pane] .xterm-screen').nth(pane).boundingBox()
  if (!box) throw new Error('terminal screen is not visible')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, deltaY)
}

/** Fill the shell with an Ink-like transcript and scroll up into it. */
async function readHistory(page: Page): Promise<number> {
  await output(page, 0, `${transcript(LINES)}${frame(0)}`)
  await expect.poll(() => rowsText(page)).toContain('> prompt')
  await wheel(page, -1200)
  await expect.poll(() => topLine(page)).toBeGreaterThan(0)
  await expect.poll(() => topLine(page)).toBeLessThan(LINES - 60)
  // Let the gesture window (400 ms) close: what follows is output, not the user.
  await page.waitForTimeout(600)
  return topLine(page)
}

test('a reader stays put through Ink redraws, focus reports and a clear-and-reprint', async ({ page }) => {
  const top = await readHistory(page)

  // The program asks for focus reports; xterm answers every focus change.
  await output(page, 0, '\x1b[?1004h')
  await page.locator('[data-terminal-pane] .xterm-helper-textarea').first().evaluate(textarea => {
    (textarea as HTMLTextAreaElement).blur(); (textarea as HTMLTextAreaElement).focus()
  })
  await expect.poll(async () => (await calls(page, 'pty_write')).map((c: any) => c.args.data)).toContain('\x1b[I')
  for (let tick = 1; tick <= 20; tick++) await output(page, 0, redraw(tick))
  await expect.poll(() => rowsText(page)).not.toContain('> prompt')
  expect(await topLine(page)).toBe(top)

  // Clear scrollback and reprint the whole transcript in one read...
  await output(page, 0, reprint(LINES, 21))
  await expect.poll(() => topLine(page)).toBe(top)
  // ...and split across two reads, as a PTY can deliver it.
  const whole = reprint(LINES, 22)
  const cut = Math.floor(whole.length / 3)
  await output(page, 0, whole.slice(0, cut))
  await output(page, 0, whole.slice(cut))
  await expect.poll(() => topLine(page)).toBe(top)
  for (let tick = 23; tick <= 30; tick++) await output(page, 0, redraw(tick))
  expect(await topLine(page)).toBe(top)

  // Wheel to the very end: live output is followed again, last row included.
  await wheel(page, 20000)
  await expect.poll(() => rowsText(page)).toContain('> prompt')
  await output(page, 0, `\r\x1b[1A\x1b[2K${line(LINES + 1)}${frame(31)}`)
  await expect.poll(() => visibleLines(page)).toContain(LINES + 1)
  await expect.poll(() => rowsText(page)).toContain('* thinking 31')
  await output(page, 0, reprint(LINES + 1, 32))
  await expect.poll(() => rowsText(page)).toContain('* thinking 32')
})

test('a reader keeps their place when the pane moves to another tab and back, and the next wheel moves from there', async ({ page }) => {
  await page.getByRole('button', { name: 'Split right', exact: true }).click()
  await expect.poll(async () => (await calls(page, 'pty_spawn')).length).toBe(2)
  await page.getByRole('button', { name: 'Unsplit to tabs', exact: true }).click()
  const tabs = page.getByRole('tablist', { name: 'Terminal tabs' }).getByRole('tab')
  await expect(tabs).toHaveCount(2)
  // Unsplit keeps the selected (second) shell in the first tab; the first
  // shell, which the helpers write to, is in the second tab.
  await tabs.nth(1).click()
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')

  const top = await readHistory(page)
  await tabs.nth(0).click()
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
  await tabs.nth(1).click()
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => topLine(page)).toBe(top)
  // A quiet shell: no output since the switch. One small wheel step up must
  // move a few lines from here, not jump from a reset scrollbar to the top.
  await page.waitForTimeout(100)
  await wheel(page, -60)
  await expect.poll(() => topLine(page)).toBeLessThan(top)
  expect(await topLine(page)).toBeGreaterThan(Math.max(1, top - 20))
})
