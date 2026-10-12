import { test, expect, seedConfirmed, emit } from './helpers'
import type { Page } from '@playwright/test'

// v0.1.5 round: pane notifications, Enter-to-confirm, terminal editing chords,
// the bundled Nerd Font and the release check, driven in Chromium against the
// mock IPC. Packaged WKWebView behaviour is covered by the release checklist.

// Release screenshots are committed; a normal test run must not rewrite them.
// Set BS_SHOTS_DIR to docs/images/releases/<version> when preparing a release.
const SHOTS = process.env.BS_SHOTS_DIR ?? 'test-results/screenshots'

test.beforeEach(async ({ page }) => {
  await seedConfirmed(page)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Start Claude chat', exact: true })).toBeVisible()
  await expect(page.locator('[data-terminal-phase="running"]')).toHaveCount(1)
})

const calls = (page: Page, cmd: string) => page.evaluate(name => (window as any).__bsInvokeLog.filter((e: any) => e.cmd === name), cmd)

/** Send terminal output to the nth spawned shell, as the PTY reader would. */
async function output(page: Page, shell: number, data: string) {
  const spawn = (await calls(page, 'pty_spawn'))[shell]
  await emit(page, `pty_data:${spawn.args.eventKey}`, { id: 1, data })
}

async function split(page: Page) {
  await page.getByRole('button', { name: 'Split right', exact: true }).click()
  await expect.poll(async () => (await calls(page, 'pty_spawn')).length).toBe(2)
}

test('a background pane that rings or sends an OSC notification gets a ring until it is focused', async ({ page }) => {
  await split(page)
  // The new (second) pane is selected. Output in it never notifies.
  await output(page, 1, '\u0007')
  await expect(page.locator('[data-pane-notification]')).toHaveCount(0)

  await output(page, 0, 'build output\r\n\u001b]777;notify;Claude Code;Waiting for your input\u0007')
  const chip = page.locator('[data-pane-notification]')
  await expect(chip).toHaveCount(1)
  await expect(chip).toContainText('Claude Code: Waiting for your input')
  await page.screenshot({ path: `${SHOTS}/pane-notification.png` })

  await page.locator('[data-terminal-pane]').first().click()
  await expect(chip).toHaveCount(0)

  // An OSC 9;4 progress report is not a notification.
  await page.locator('[data-terminal-pane]').nth(1).click()
  await output(page, 0, '\u001b]9;4;1;40\u0007')
  await expect(chip).toHaveCount(0)
})

test('a hidden terminal tab shows a dot and the jump shortcut opens it', async ({ page }) => {
  await split(page)
  await page.getByRole('button', { name: 'Unsplit to tabs', exact: true }).click()
  const tabs = page.getByRole('tablist', { name: 'Terminal tabs' }).getByRole('tab')
  await expect(tabs).toHaveCount(2)
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')

  // Unsplit keeps the selected pane (the second shell) in the first tab and
  // moves the first shell to a new, hidden tab.
  await output(page, 1, '\u0007')
  await expect(page.locator('[data-tab-notification]')).toHaveCount(0)
  await output(page, 0, '\u0007')
  await expect(page.locator('[data-tab-notification]')).toHaveCount(1)
  await expect(tabs.nth(1)).toHaveAccessibleName(/1 waiting/)

  await page.keyboard.press('Meta+Shift+u')
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-tab-notification]')).toHaveCount(0)
})

test('a pane in another workspace marks that workspace tab, and auto-switch opens it', async ({ page }) => {
  await page.getByRole('tab', { name: 'Nexus' }).click()
  await expect.poll(async () => (await calls(page, 'pty_spawn')).length).toBe(2)
  await output(page, 0, '\u0007')
  await expect(page.locator('[data-workspace-notification="proj-a"]')).toHaveCount(1)

  await page.getByTitle('Open settings', { exact: true }).click()
  await page.getByRole('button', { name: 'Notifications', exact: true }).click()
  await expect(page.getByText('1 pane is waiting.')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/settings-notifications.png` })
  await page.getByLabel('Switch to the pane that notified', { exact: true }).check()
  await page.getByRole('button', { name: 'Close settings' }).click()

  // The setting applies to the next notification; it waits for a typing pause.
  await output(page, 0, '\u001b]9;Tests passed\u0007')
  await expect(page.locator('.bs-tab--active')).toHaveText('Beads-Station', { timeout: 8000 })
  await expect(page.locator('[data-workspace-notification]')).toHaveCount(0)
  await expect(page.locator('[data-pane-notification]')).toHaveCount(0)

  await page.reload()
  await page.getByTitle('Open settings', { exact: true }).click()
  await page.getByRole('button', { name: 'Notifications', exact: true }).click()
  await expect(page.getByLabel('Switch to the pane that notified', { exact: true })).toBeChecked()
})

test('Enter confirms a destructive dialog and Escape cancels it', async ({ page }) => {
  await split(page)
  await page.getByRole('button', { name: 'Close pane', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: 'Continue', exact: true })).toBeFocused()
  await page.screenshot({ path: `${SHOTS}/confirm-enter.png` })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('[data-terminal-pane]')).toHaveCount(2)

  await page.getByRole('button', { name: 'Close pane', exact: true }).click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('[data-terminal-pane]')).toHaveCount(1)
  await expect.poll(async () => (await calls(page, 'pty_kill')).length).toBe(1)
})

test('macOS editing chords reach the shell and can be turned off', async ({ page }) => {
  const writes = async () => (await calls(page, 'pty_write')).map((e: any) => e.args.data)
  await page.locator('.xterm-helper-textarea').first().focus()
  await page.keyboard.press('Meta+ArrowLeft')
  await page.keyboard.press('Meta+ArrowRight')
  await page.keyboard.press('Meta+Backspace')
  await page.keyboard.press('Shift+Enter')
  await expect.poll(writes).toEqual(['\u0001', '\u0005', '\u0015', '\u001b\r'])

  await page.getByTitle('Open settings', { exact: true }).click()
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await page.getByLabel('macOS editing shortcuts', { exact: true }).uncheck()
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.locator('.xterm-helper-textarea').first().focus()
  await page.keyboard.press('Shift+Enter')
  await expect.poll(async () => (await writes()).at(-1)).toBe('\r')
})

test('terminal panes use the bundled Nerd Font for icon glyphs', async ({ page }) => {
  const stack = await page.locator('.xterm-rows').first().evaluate(element => getComputedStyle(element).fontFamily)
  expect(stack).toContain('JetBrainsMono Nerd Font')
  // U+E0B0 (powerline) and U+F07B (folder) exist only in the bundled font.
  const loaded = await page.evaluate(async () => {
    const faces = await document.fonts.load("13px 'JetBrainsMono Nerd Font'", '')
    return faces.map(face => `${face.family}:${face.status}`)
  })
  expect(loaded.join()).toContain('JetBrainsMono Nerd Font')
  expect(loaded.join()).toContain('loaded')
  await output(page, 0, 'icons:     \r\n')
  await expect(page.locator('.xterm-rows').first()).toContainText('icons:')
  await page.screenshot({ path: `${SHOTS}/nerd-font-icons.png` })
})

test('About checks for a newer release and downloads it only on request', async ({ page }) => {
  await page.getByTitle('Open settings', { exact: true }).click()
  await page.getByRole('button', { name: 'About', exact: true }).click()
  const status = page.getByTestId('update-status')
  await expect(page.getByRole('button', { name: /^(Download|Install)/ })).toHaveCount(0)

  await page.evaluate(() => {
    (window as any).__bsMockUpdate = { current: '0.1.5', latest: 'v9.9.9', newer: true, url: 'https://example.invalid/v9.9.9', asset: 'Beads.Station_9.9.9_aarch64.dmg' }
  })
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click()
  await expect(status).toHaveText('v9.9.9 is available')
  await page.screenshot({ path: `${SHOTS}/about-update.png` })
  expect(await calls(page, 'app_download_update')).toHaveLength(0)

  expect(await calls(page, 'app_prepare_update')).toHaveLength(0)

  await page.getByRole('button', { name: 'Download only', exact: true }).click()
  await expect(status).toHaveText('v9.9.9 downloaded and opened in Finder')
  expect((await calls(page, 'app_download_update'))[0].args).toEqual({ tag: 'v9.9.9' })
  await page.getByRole('button', { name: 'Close settings' }).click()
  await expect(page.getByRole('button', { name: 'Update v9.9.9' })).toBeVisible()
})

test('Install prepares the update and replaces nothing until Restart to update', async ({ page }) => {
  await page.getByTitle('Open settings', { exact: true }).click()
  await page.getByRole('button', { name: 'About', exact: true }).click()
  await page.evaluate(() => {
    (window as any).__bsMockUpdate = { current: '0.1.5', latest: 'v9.9.9', newer: true, url: 'https://example.invalid/v9.9.9', asset: 'Beads.Station_9.9.9_aarch64.dmg' }
  })
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click()
  await page.getByRole('button', { name: 'Install v9.9.9', exact: true }).click()
  await expect(page.getByTestId('update-status')).toHaveText('v9.9.9 is ready to install')
  expect((await calls(page, 'app_prepare_update'))[0].args).toEqual({ tag: 'v9.9.9' })
  expect(await calls(page, 'app_apply_update')).toHaveLength(0)
  await page.getByRole('button', { name: 'Restart to update', exact: true }).click()
  await expect.poll(async () => (await calls(page, 'app_apply_update')).length).toBe(1)
})

test('the waiting-panes panel lists each waiting pane, jumps to one and dismisses another', async ({ page }) => {
  await split(page)
  await output(page, 0, '\u001b]777;notify;Build;finished\u0007')
  const waiting = page.getByRole('button', { name: /^Waiting 1/ })
  await expect(waiting).toBeVisible()
  await waiting.click()

  const panel = page.getByRole('dialog', { name: 'Waiting panes' })
  await expect(panel).toContainText('Build: finished')
  await expect(panel).toContainText('terminal · tab 1')
  await panel.getByRole('button', { name: /^Dismiss notification/ }).click()
  await expect(panel).toContainText('Nothing is waiting for you.')
  await expect(page.locator('[data-pane-notification]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)

  // Jumping focuses the pane that notified and closes the panel.
  await output(page, 0, '\u0007')
  await page.keyboard.press('Meta+i')
  await page.getByRole('dialog', { name: 'Waiting panes' }).locator('.bs-notification-panel__jump').click()
  await expect(page.getByRole('dialog', { name: 'Waiting panes' })).toHaveCount(0)
  await expect(page.locator('[data-pane-notification]')).toHaveCount(0)
})
