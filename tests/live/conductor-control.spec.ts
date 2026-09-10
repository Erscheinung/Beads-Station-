import { test, expect } from './helpers'

// Code-9ud — Intelligent Conductor control + live footer live-verify.
// Boots the Designer skin (?ui=designer) in browser-mock mode. conductor_start
// / conductor_stop are mocked void; ConductorStatus is pushed via __bsMockEmit
// so the assertions prove the frontend both FIRES the commands and REACTS to
// the backend's `conductor_status` event (footer + card).

async function bootDesigner(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => { localStorage.setItem('beads-station.workspaces.v2', JSON.stringify({ openIds: ['proj-a'], activeId: 'proj-a' })) })
  await page.goto('/?ui=designer')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  await expect(page.locator('#root')).toBeVisible()
}

test('the CONDUCTOR card renders with a Start button; footer starts stopped', async ({ page }) => {
  await bootDesigner(page)
  await expect(page.getByText('CONDUCTOR', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible()
  // No status event yet -> stopped presentation. Text appears in both the card
  // and the footer (shared source of truth), so match the first.
  await expect(page.getByText('Conductor stopped').first()).toBeVisible()
})

test('Start fires conductor_start with the repo path and dry-run', async ({ page }) => {
  await bootDesigner(page)
  await page.getByRole('button', { name: 'Start' }).click()
  await expect
    .poll(async () => {
      const log = await page.evaluate(() => (window as any).__bsInvokeLog ?? [])
      return log.some(
        (e: { cmd: string; args?: Record<string, unknown> }) =>
          e.cmd === 'conductor_start' &&
          typeof e.args?.repoPath === 'string' &&
          (e.args?.repoPath as string).length > 0 &&
          e.args?.dryRun === true,
      )
    })
    .toBe(true)
})

test('a conductor_status event drives the footer + card to awake', async ({ page }) => {
  await bootDesigner(page)
  await page.evaluate(() =>
    (window as any).__bsMockEmit('conductor_status', {
      state: 'awake',
      bead_id: 'Code-xyz',
      detail: 'advancing molecule step',
      last_pulse_ms: null,
      interval_secs: 1200,
      repo_path: '/tmp/beads-station',
    }),
  )
  await expect(page.getByText('Conductor awake · Code-xyz').first()).toBeVisible()
  await expect(page.getByText('advancing molecule step')).toBeVisible()
  // Now running -> the toggle becomes Stop.
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()
})

test('Stop fires conductor_stop; a stopped status returns the footer to stopped', async ({ page }) => {
  await bootDesigner(page)
  // Bring it up first so the toggle shows Stop.
  await page.evaluate(() =>
    (window as any).__bsMockEmit('conductor_status', {
      state: 'awake',
      bead_id: 'Code-xyz',
      detail: null,
      last_pulse_ms: null,
      interval_secs: 1200,
      repo_path: '/tmp/beads-station',
    }),
  )
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect
    .poll(async () => {
      const log = await page.evaluate(() => (window as any).__bsInvokeLog ?? [])
      return log.some((e: { cmd: string }) => e.cmd === 'conductor_stop')
    })
    .toBe(true)
  // Backend confirms with a stopped status -> footer reflects it.
  await page.evaluate(() =>
    (window as any).__bsMockEmit('conductor_status', {
      state: 'stopped',
      bead_id: null,
      detail: null,
      last_pulse_ms: null,
      interval_secs: 1200,
      repo_path: '/tmp/beads-station',
    }),
  )
  await expect(page.getByText('Conductor stopped').first()).toBeVisible()
})
