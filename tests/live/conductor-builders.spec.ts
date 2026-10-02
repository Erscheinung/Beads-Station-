import { test, expect, emitUntil } from './helpers'

// RV8.1 — per-child builder cards. During a fanout the backend pushes one
// BuilderStatus per builder on the SEPARATE `conductor_builder` event; the
// ActiveAgents panel renders one card per builder (keyed by bead id), each with
// its own Stop/Defer, and suppresses the aggregate conductor card. We drive the
// builder frames via __bsMockEmit and assert the cards + per-card Stop wiring.

async function bootDesigner(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => { localStorage.setItem('beads-station.workspaces.v2', JSON.stringify({ openIds: ['proj-a'], activeId: 'proj-a' })) })
  await page.goto('/?ui=designer')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  await expect(page.locator('#root')).toBeVisible()
}

function builder(bead_id: string, state: string, extra: Record<string, unknown> = {}) {
  return {
    bead_id,
    title: `work ${bead_id}`,
    state,
    epic_id: 'Code-epic',
    model: 'claude-sonnet-5',
    tier: 'M',
    detail: null,
    last_pulse_ms: null,
    ...extra,
  }
}

test('two conductor_builder frames render two per-child cards', async ({ page }) => {
  await bootDesigner(page)
  await emitUntil(
    page,
    [['conductor_builder', builder('Code-b1', 'waking')], ['conductor_builder', builder('Code-b2', 'waking')]],
    () => expect(page.locator('[data-bs-builder-card]')).toHaveCount(2, { timeout: 500 }),
  )
  await expect(page.locator('[data-bs-builder-card]')).toHaveCount(2)
  await expect(page.locator('[data-bs-builder-card="Code-b1"]')).toBeVisible()
  await expect(page.locator('[data-bs-builder-card="Code-b2"]')).toBeVisible()
  // The model badge surfaces the tier -> model mapping (RV8.3).
  await expect(page.getByText('Sonnet').first()).toBeVisible()
})

test('Stop on one builder card fires conductor_stop_agent with only that bead id', async ({ page }) => {
  await bootDesigner(page)
  await emitUntil(
    page,
    [['conductor_builder', builder('Code-b1', 'waking')], ['conductor_builder', builder('Code-b2', 'waking')]],
    () => expect(page.locator('[data-bs-builder-card]')).toHaveCount(2, { timeout: 500 }),
  )
  const card1 = page.locator('[data-bs-builder-card="Code-b1"]')
  await card1.getByRole('button', { name: 'Stop' }).click()
  await expect
    .poll(async () => {
      const log = await page.evaluate(() => (window as any).__bsInvokeLog ?? [])
      const stops = log.filter((e: { cmd: string }) => e.cmd === 'conductor_stop_agent')
      return stops.map((e: { args?: Record<string, unknown> }) => e.args?.beadId)
    })
    .toEqual(['Code-b1'])
})

test('a blocked builder card persists and shows the blocked action', async ({ page }) => {
  await bootDesigner(page)
  const card = page.locator('[data-bs-builder-card="Code-b3"]')
  await emitUntil(page, [['conductor_builder', builder('Code-b3', 'blocked', { detail: 'needs input' })]], () => expect(card).toBeVisible({ timeout: 500 }))
  await expect(card.getByText(/Blocked/)).toBeVisible()
  // Defer is always offered on a builder card that carries a bead.
  await expect(card.getByRole('button', { name: 'Defer' })).toBeVisible()
})
