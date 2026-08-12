import { test, expect } from './helpers'

// RV5.0 (Code-ew0) — cockpit gate view live-verify.
// Boots the Designer skin (?ui=designer) in browser-mock mode; the mock's
// bd_gate_list returns one open human gate. Asserts the NEXT UP · GATES card
// renders that gate, and that Approve fires bd_gate_resolve with its id.
//
// Designer boot is lighter than the shell boot() helper (no __bsVim/__bsTerm
// mirrors exist in the designer skin) — just navigate + wait for mock IPC.

async function bootDesigner(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/?ui=designer')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  await expect(page.locator('#root')).toBeVisible()
}

test('the cockpit lists an open human gate with approve/reject', async ({ page }) => {
  await bootDesigner(page)
  // The NEXT UP · GATES card renders the mock gate.
  await expect(page.getByText('NEXT UP · GATES')).toBeVisible()
  await expect(page.getByText('Code-mol-gate1')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reject' })).toBeVisible()
})

test('Approve fires bd_gate_resolve with the gate id', async ({ page }) => {
  await bootDesigner(page)
  await expect(page.getByText('Code-mol-gate1')).toBeVisible()
  await page.getByRole('button', { name: 'Approve' }).click()
  await expect
    .poll(async () => {
      const log = await page.evaluate(() => (window as any).__bsInvokeLog ?? [])
      return log.some(
        (e: { cmd: string; args?: Record<string, unknown> }) =>
          e.cmd === 'bd_gate_resolve' && e.args?.id === 'Code-mol-gate1',
      )
    })
    .toBe(true)
})

test('Reject notes the gate (bd_note) without resolving it', async ({ page }) => {
  await bootDesigner(page)
  await expect(page.getByText('Code-mol-gate1')).toBeVisible()
  await page.getByRole('button', { name: 'Reject' }).click()
  await expect
    .poll(async () => {
      const log = await page.evaluate(() => (window as any).__bsInvokeLog ?? [])
      const noted = log.some(
        (e: { cmd: string; args?: Record<string, unknown> }) =>
          e.cmd === 'bd_note' && e.args?.id === 'Code-mol-gate1',
      )
      const resolved = log.some((e: { cmd: string }) => e.cmd === 'bd_gate_resolve')
      return noted && !resolved
    })
    .toBe(true)
})
