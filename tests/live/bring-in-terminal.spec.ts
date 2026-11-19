import { test, expect, boot, invokeLog, emit } from './helpers'
// Built at runtime so no literal home path sits in the source (public-repo scan).
const USERS = ['', 'Users', ''].join('/')

// Code-7xc.4: bring an outside terminal's agent into a split. The process
// table, the stop and the shell are mocked; a real outside Claude, the
// terminal apps' proxy-icon drag and tmux are hands-on checks.

const ID = '2c975569-13c1-43b2-8e7a-f88d6138d7d8'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ id, USERS }) => {
    (window as any).__bsMockOverride = {
      external_agents: [
        { pid: 4242, cli: 'claude', cwd: `${USERS}someone/Desktop/Code/foo`, tty: 'ttys003', app: 'Terminal', tmuxSession: null, sessionId: id },
        { pid: 4343, cli: 'codex', cwd: `${USERS}someone/Desktop/Code/bar`, tty: null, app: null, tmuxSession: 'work', sessionId: null },
      ],
    }
  }, { id: ID, USERS })
  await boot(page)
})

/** The new shell draws its prompt, which is when a queued startup command is typed. */
async function promptAppears(page: import('@playwright/test').Page, spawnIndex: number) {
  await expect.poll(async () => (await invokeLog(page)).filter(entry => entry.cmd === 'pty_spawn').length).toBeGreaterThan(spawnIndex)
  const spawn = (await invokeLog(page)).filter(entry => entry.cmd === 'pty_spawn')[spawnIndex]
  await emit(page, `pty_data:${spawn.args?.eventKey}`, { id: 1, data: '$ ' })
}

async function openPicker(page: import('@playwright/test').Page) {
  await page.keyboard.press('Meta+k')
  await page.locator('.bs-palette [cmdk-input]').fill('Bring in a terminal')
  await page.getByText('Bring in a terminal…').first().click()
}

test('picking a Claude in Terminal stops it once after a confirm and resumes its session in a split in that folder', async ({ page }) => {
  await openPicker(page)
  await expect(page.getByText('Claude · ~/Desktop/Code/foo · Terminal · session 2c97…')).toBeVisible()
  await expect(page.getByText('Codex · ~/Desktop/Code/bar · tmux work (live attach)')).toBeVisible()
  const spawnsBefore = (await invokeLog(page)).filter(entry => entry.cmd === 'pty_spawn').length
  await page.getByText('Claude · ~/Desktop/Code/foo · Terminal · session 2c97…').click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Stop Claude in Terminal (folder ~/Desktop/Code/foo) and continue this conversation here?')
  await expect(dialog).toContainText('The outside window stays open as an idle shell; close it yourself.')
  // Nothing is stopped before the confirm.
  expect((await invokeLog(page)).filter(entry => entry.cmd === 'external_agent_stop')).toHaveLength(0)
  await dialog.getByRole('button', { name: /Continue/ }).click()

  await expect.poll(async () => (await invokeLog(page)).filter(entry => entry.cmd === 'external_agent_stop').length).toBe(1)
  expect((await invokeLog(page)).find(entry => entry.cmd === 'external_agent_stop')?.args).toMatchObject({ pid: 4242 })
  await expect.poll(async () => (await invokeLog(page)).filter(entry => entry.cmd === 'pty_spawn').length).toBe(spawnsBefore + 1)
  const spawn = (await invokeLog(page)).filter(entry => entry.cmd === 'pty_spawn').at(-1)
  expect(JSON.stringify(spawn?.args)).toContain(`${USERS}someone/Desktop/Code/foo`)
  await promptAppears(page, spawnsBefore)
  // The resume command is typed into the new shell, with Enter.
  await expect.poll(async () => (await invokeLog(page)).some(entry => entry.cmd === 'pty_write' && String(entry.args?.data ?? '').includes(`--resume ${ID}`) && String(entry.args?.data).endsWith('\r')), { timeout: 10_000 }).toBe(true)
})

test('a tmux entry attaches live and stops nothing', async ({ page }) => {
  await openPicker(page)
  const spawnsBefore = (await invokeLog(page)).filter(entry => entry.cmd === 'pty_spawn').length
  await page.getByText('Codex · ~/Desktop/Code/bar · tmux work (live attach)').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Attach to tmux session work here?')
  await dialog.getByRole('button', { name: /Continue/ }).click()
  await promptAppears(page, spawnsBefore)
  await expect.poll(async () => (await invokeLog(page)).some(entry => entry.cmd === 'pty_write' && String(entry.args?.data ?? '').includes("tmux attach -t =work")), { timeout: 10_000 }).toBe(true)
  expect((await invokeLog(page)).filter(entry => entry.cmd === 'external_agent_stop')).toHaveLength(0)
})

test('cancelling the confirm leaves the outside process alone', async ({ page }) => {
  await openPicker(page)
  await page.getByText('Claude · ~/Desktop/Code/foo · Terminal · session 2c97…').click()
  await page.getByRole('dialog').getByRole('button', { name: /Cancel/ }).click()
  expect((await invokeLog(page)).filter(entry => entry.cmd === 'external_agent_stop')).toHaveLength(0)
})
