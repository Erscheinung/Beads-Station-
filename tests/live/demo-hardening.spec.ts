import { test, expect, type Page } from '@playwright/test'

// Track E (Code-o40) — demo-readiness hardening live-verify.
// Drives the empty/loading/error conditions the static fixtures can't reach by
// seeding window.__bsMockOverride BEFORE boot (see src/test-harness/mockIpc.ts).
// Each case asserts a surface degrades to a purposeful state instead of a
// permanent "Loading…"/"Sensing…" hang or an EMPTY string masking a real error.

/** Seed per-cmd mock overrides, then boot the designer skin. Overrides must be
 *  installed before the page script runs, so this uses addInitScript. */
async function bootDesignerWith(
  page: Page,
  override: Record<string, unknown>,
): Promise<void> {
  await page.addInitScript(o => {
    ;(window as any).__bsMockOverride = o
  }, override)
  await page.goto('/?ui=designer')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  await expect(page.locator('#root')).toBeVisible()
}

async function bootTerminalWith(
  page: Page,
  override: Record<string, unknown>,
): Promise<void> {
  await page.addInitScript(o => {
    ;(window as any).__bsMockOverride = o
  }, override)
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  await expect(page.locator('#root')).toBeVisible()
}

// --- GAP-3: no project selected must not hang the gate/sensor panels ---------

test('GateCockpit shows "No project selected." (not a permanent "Loading gates…") with no project', async ({
  page,
}) => {
  await bootDesignerWith(page, { projects_list: [] })
  const cockpit = page.getByTestId('gate-cockpit')
  await expect(cockpit.getByText('NEXT UP · GATES')).toBeVisible()
  await expect(cockpit.getByText('No project selected.')).toBeVisible()
  await expect(cockpit.getByText('Loading gates…')).toHaveCount(0)
})

test('SensorsPanel shows "No project selected." (not a permanent "Sensing…") with no project', async ({
  page,
}) => {
  await bootDesignerWith(page, { projects_list: [] })
  const sensors = page.getByTestId('sensors-panel')
  await expect(sensors.getByText('SENSED · WISPS')).toBeVisible()
  await expect(sensors.getByText('No project selected.')).toBeVisible()
  await expect(sensors.getByText('Sensing…')).toHaveCount(0)
})

// --- GAP-2 / GAP-4: a bd_snapshot reject must surface, not read as EMPTY -----

test('Timeline surfaces a bd error instead of the empty "No closed beads yet" string', async ({
  page,
}) => {
  await bootDesignerWith(page, { bd_snapshot: '__bsThrow:snapshot boom' })
  // Timeline only renders under the Timeline nav item (default nav is graph).
  await page.getByText('Timeline', { exact: true }).click()
  const timeline = page.locator('#du-timeline')
  await expect(timeline.getByText(/bd error:/)).toBeVisible()
  await expect(timeline.getByText('No closed beads yet. Ship one and it lands here.')).toHaveCount(0)
})

test('ActiveAgents NEXT UP surfaces a bd error instead of "Nothing ready — queue is clear."', async ({
  page,
}) => {
  await bootDesignerWith(page, { bd_snapshot: '__bsThrow:snapshot boom' })
  const agents = page.locator('#du-agents-panel')
  await expect(agents.getByText('NEXT UP · auto-picked')).toBeVisible()
  await expect(agents.getByText(/bd error:/)).toBeVisible()
  await expect(agents.getByText('Nothing ready — queue is clear.')).toHaveCount(0)
})

// --- GAP-5: a failed projects_list must read differently from an empty one ---

test('Dashboard (terminal skin) shows the plain empty state when projects_list is empty', async ({
  page,
}) => {
  await bootTerminalWith(page, { projects_list: [] })
  await expect(page.getByText('to pick project')).toBeVisible()
  await expect(page.getByText(/Couldn't load projects/)).toHaveCount(0)
})

test('Dashboard (terminal skin) shows "Couldn\'t load projects" when projects_list rejects', async ({
  page,
}) => {
  await bootTerminalWith(page, { projects_list: '__bsThrow:projects boom' })
  await expect(page.getByText(/Couldn't load projects/)).toBeVisible()
})
