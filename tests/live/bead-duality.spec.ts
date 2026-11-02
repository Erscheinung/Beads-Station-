import { test, expect } from '@playwright/test'

// RV8.4 — bead-pane duality. Clicking a READY bead in the graph spawns a Claude
// agent pane targeting the active project; blocked/closed nodes are inert. The
// Designer skin renders BeadGraph as the default center view, so we click a node
// and assert a new [data-bs-agent-pane] appears (the same locator spawnAgentPane
// waits on in helpers.ts).

async function bootDesigner(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => { localStorage.setItem('beads-station.workspaces.v2', JSON.stringify({ openIds: ['proj-a'], activeId: 'proj-a' })) })
  await page.goto('/?ui=designer')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  await expect(page.locator('#root')).toBeVisible()
  await page.getByRole('button', { name: 'Bead map', exact: true }).click()
  // The graph renders the mock SNAPSHOT (Code-aaa/Code-bbb are ready).
  await expect(page.locator('[data-bs-bead-node]').first()).toBeVisible()
}

test('double-clicking a bead opens ticket-bound work without starting an agent', async ({ page }) => {
  await bootDesigner(page)
  const ready = page.locator('[data-bs-bead-node][data-bs-bead-state="ready"]').first()
  await expect(ready).toBeVisible()
  await ready.dblclick()
  await expect(page.getByTestId('designer-ticket-run')).toBeVisible()
  await expect(page.locator('[data-bs-agent-pane]')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__bsInvokeLog.filter((entry: any) => entry.cmd === 'native_run_start'))).toEqual([])
})

test('a single click inspects a bead and spawns nothing', async ({ page }) => {
  await bootDesigner(page)
  const blocked = page.locator('[data-bs-bead-node][data-bs-bead-state="blocked"]').first()
  // The mock snapshot has a blocked bead (Code-ddd). If present, clicking is inert.
  if ((await blocked.count()) === 0) test.skip()
  const before = await page.locator('[data-bs-agent-pane]').count()
  await blocked.click()
  await expect(page.getByTestId('bead-inspector')).toBeVisible()
  await expect(page.getByTestId('designer-ticket-run')).toHaveCount(0)
  await expect(page.locator('[data-bs-agent-pane]')).toHaveCount(before)
})

test('long graph titles expand their cards and preserve the gap below', async ({ page }) => {
  const longTitle = 'Redesign the provider chat and agent process panel so its controls remain readable'
  const issue = (id: string, title: string) => ({
    id, title, status: 'open', priority: 2, description: null, issue_type: 'feature',
    assignee: null, created_at: '2026-09-15T00:00:00Z', updated_at: '2026-09-15T00:00:00Z',
    closed_at: null, dependency_count: 0, dependent_count: 0, comment_count: 0,
    labels: null, parent: null, dependencies: [],
  })
  const first = issue('Code-long-a', longTitle)
  const second = issue('Code-long-b', 'A second card must begin after the expanded card')

  await page.addInitScript(({ first, second }) => {
    localStorage.setItem('beads-station.workspaces.v2', JSON.stringify({ openIds: ['proj-a'], activeId: 'proj-a' }))
    ;(window as any).__bsMockOverride = {
      bd_snapshot: { ready: [first, second], all: [first, second], no_db: false },
    }
  }, { first, second })
  await page.goto('/?ui=designer')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  await page.getByRole('button', { name: 'Bead map', exact: true }).click()

  const cards = page.locator('[data-bs-bead-node]')
  await expect(cards).toHaveCount(2)
  const firstCard = cards.nth(0)
  const secondCard = cards.nth(1)
  const geometry = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-bs-bead-node]'))
    const [first, second] = nodes.map(node => node.getBoundingClientRect())
    const title = nodes[0].lastElementChild as HTMLElement
    return { first, second, titleFits: title.scrollHeight <= title.clientHeight }
  })

  expect(geometry.first.height).toBeGreaterThan(64)
  expect(geometry.second.top - geometry.first.bottom).toBeGreaterThanOrEqual(12)
  expect(geometry.titleFits).toBe(true)
})
