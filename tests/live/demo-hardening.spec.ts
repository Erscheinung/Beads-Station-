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

// --- GAP-3: GateCockpit / SensorsPanel must not hang on a permanent ----------
// --- "Loading gates…" / "Sensing…" when there is no project. --------------------
// NOTE: with no projects at all, Code-9z4 now short-circuits the whole designer
// shell to the first-run panel (see the Code-9z4 cases below), so the panels
// never mount in that condition. The per-panel "No project selected." branch
// (Code-o40.1) still guards the transient/!repoPath case; it is exercised by
// the shell-level first-run assertion rather than a standalone empty-projects
// mount here.

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

// --- Code-9z4: designer skin needs first-run parity, not a shell full of ------
// --- "No project selected." --------------------------------------------------

test('Designer skin shows the first-run panel (not the shell) when projects_list is empty', async ({
  page,
}) => {
  await bootDesignerWith(page, { projects_list: [] })
  const empty = page.getByTestId('designer-empty-state')
  await expect(empty).toBeVisible()
  await expect(empty.getByText('No projects yet')).toBeVisible()
  // The shell's surfaces must not render — no per-panel "No project selected." hang.
  await expect(page.getByText('No project selected.')).toHaveCount(0)
})

test('Designer skin first-run panel shows the error variant when projects_list rejects', async ({
  page,
}) => {
  await bootDesignerWith(page, { projects_list: '__bsThrow:projects boom' })
  const empty = page.getByTestId('designer-empty-state')
  await expect(empty).toBeVisible()
  await expect(empty.getByText('Couldn\'t load projects')).toBeVisible()
})

// --- Code-6if: in-app skin toggle so both skins are reachable in one window ---

test('Designer top-bar "Terminal skin" button switches to the terminal shell', async ({
  page,
}) => {
  // Default mock has projects, so the designer shell (with its top-bar) renders.
  await bootDesignerWith(page, {})
  await expect(page.getByRole('button', { name: 'Terminal skin' })).toBeVisible()
  await page.getByRole('button', { name: 'Terminal skin' }).click()
  // Terminal shell is up: the designer top-bar control is gone, and a
  // terminal-only surface (the tab bar / board) is present.
  await expect(page.getByRole('button', { name: 'Terminal skin' })).toHaveCount(0)
  await expect(page.locator('.du-theme').first()).toHaveCount(0)
})
