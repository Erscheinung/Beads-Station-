import { test, expect } from '@playwright/test'

// RV8.4 — bead-pane duality. Clicking a READY bead in the graph spawns a Claude
// agent pane targeting the active project; blocked/closed nodes are inert. The
// Designer skin renders BeadGraph as the default center view, so we click a node
// and assert a new [data-bs-agent-pane] appears (the same locator spawnAgentPane
// waits on in helpers.ts).

async function bootDesigner(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/?ui=designer')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  await expect(page.locator('#root')).toBeVisible()
  // The graph renders the mock SNAPSHOT (Code-aaa/Code-bbb are ready).
  await expect(page.locator('[data-bs-bead-node]').first()).toBeVisible()
}

test('clicking a ready bead node spawns an agent pane (and lands on the terminal skin)', async ({ page }) => {
  await bootDesigner(page)
  const ready = page.locator('[data-bs-bead-node][data-bs-bead-state="ready"]').first()
  await expect(ready).toBeVisible()
  await ready.click()
  // Agent panes render in the terminal skin; the click switches skins and lands
  // on the freshly-spawned pane. At least one agent pane is now mounted.
  await expect(page.locator('[data-bs-agent-pane]').first()).toBeVisible()
})

test('a non-ready bead node does not spawn a pane', async ({ page }) => {
  await bootDesigner(page)
  const blocked = page.locator('[data-bs-bead-node][data-bs-bead-state="blocked"]').first()
  // The mock snapshot has a blocked bead (Code-ddd). If present, clicking is inert.
  if ((await blocked.count()) === 0) test.skip()
  const before = await page.locator('[data-bs-agent-pane]').count()
  await blocked.click()
  // No new pane — give the app a beat to (not) react.
  await page.waitForTimeout(150)
  await expect(page.locator('[data-bs-agent-pane]')).toHaveCount(before)
})
