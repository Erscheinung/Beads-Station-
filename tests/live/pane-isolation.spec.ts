import { test, expect, boot, spawnAgentPane, leader } from './helpers'

// Code-51e — multi-agent pane focus + kill isolation.
// Regression: legacy chat leaked a claude child per project switch, exhausting
// forks until bd reads failed ("issues gone"). Fix keeps agent panes persistent
// (not killed on unmount) and reaps via claude_reconcile; closeActivePane kills
// ONLY the active leaf. These specs assert the observable guarantees:
//   - spawning N panes adds exactly N agent panes
//   - <leader>x kills exactly one; siblings keep their bridge ids
//   - the sidebar issue list still populates after pane churn + project switch
// The app boots with one agent pane already present, so counts are measured
// relative to that baseline rather than hardcoded.

const pane = (p: import('@playwright/test').Page) => p.locator('[data-bs-agent-pane]')

test.beforeEach(async ({ page }) => {
  await boot(page)
})

test('each spawn adds exactly one agent pane', async ({ page }) => {
  const base = await pane(page).count()
  await spawnAgentPane(page)
  await spawnAgentPane(page)
  await spawnAgentPane(page)
  await expect(pane(page)).toHaveCount(base + 3)
})

test('<leader>x kills exactly one pane; siblings survive with their bridge ids', async ({ page }) => {
  await spawnAgentPane(page)
  await spawnAgentPane(page)
  const before = await pane(page).count()
  const bridgesBefore = await pane(page).evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-bs-agent-pane')),
  )

  // leader-x closes the active pane (useVimNav.ts:296). Requires terminal focus,
  // which spawnAgentPane leaves us in.
  await leader(page)
  await page.keyboard.press('x')

  await expect(pane(page)).toHaveCount(before - 1)

  const bridgesAfter = await pane(page).evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-bs-agent-pane')),
  )
  // Every surviving bridge was one of the originals (kill removed one, re-minted none).
  for (const b of bridgesAfter) expect(bridgesBefore).toContain(b)
  expect(bridgesAfter).toHaveLength(before - 1)
})

test('exactly one agent pane shows the active focus ring', async ({ page }) => {
  await spawnAgentPane(page)
  await spawnAgentPane(page)

  // The blue focus ring is an inset boxShadow on the pane WRAPPER
  // (TerminalPanes.tsx:131), which is an ancestor of [data-bs-agent-pane]
  // (the ClaudeChat root, ClaudeChat.tsx:412). Walk up from each agent pane
  // and count how many have an ancestor carrying the ring's boxShadow.
  const ringed = await pane(page).evaluateAll((els) => {
    let count = 0
    for (const el of els) {
      let node: HTMLElement | null = el as HTMLElement
      while (node) {
        const bs = getComputedStyle(node).boxShadow
        if (bs && bs !== 'none' && bs.includes('inset')) { count++; break }
        node = node.parentElement
      }
    }
    return count
  })
  expect(ringed).toBe(1)
})

test('sidebar issue list still populates after pane churn + project switch (no "issues gone")', async ({ page }) => {
  // Sidebar renders the seeded snapshot on boot: 6 issues under the BEADS repo.
  const sidebar = page.locator('aside')
  await expect(sidebar).toContainText('BEADS')
  await expect(sidebar).toContainText('(6)')

  // Churn: spawn panes, kill one, switch project twice (back to start).
  await spawnAgentPane(page)
  await spawnAgentPane(page)
  const before = await pane(page).count()
  await leader(page)
  await page.keyboard.press('x')
  await expect(pane(page)).toHaveCount(before - 1)

  // leader-p cycles the active project (useVimNav.ts:419 → project:cycle).
  await leader(page)
  await page.keyboard.press('p')
  await leader(page)
  await page.keyboard.press('p')

  // bd reads must still succeed — the sidebar repopulates, not empty.
  await expect(sidebar).toContainText('(6)')
})

// Code-x8p — the pane surface is keyed by project. Agent panes spawned on one
// project must NOT appear under another project's surface, and must be restored
// on a round-trip switch. (The baseline single [data-bs-agent-pane] is the
// legacy bottom chat, which is keyed by active.id and re-renders on every
// project, so it is present on both — the DELTA is the per-project agent leaves.)
test('agent panes are per-project: hidden on switch, restored on return', async ({ page }) => {
  const base = await pane(page).count() // legacy bottom chat only

  // Spawn two agent panes on the active project (proj-a).
  await spawnAgentPane(page)
  await spawnAgentPane(page)
  await expect(pane(page)).toHaveCount(base + 2)

  // leader-p cycles to proj-b — its own fresh surface has no agent leaves, so
  // only the legacy bottom chat remains.
  await leader(page)
  await page.keyboard.press('p')
  await expect(pane(page)).toHaveCount(base)

  // leader-p again returns to proj-a — its two agent panes are restored.
  await leader(page)
  await page.keyboard.press('p')
  await expect(pane(page)).toHaveCount(base + 2)
})
