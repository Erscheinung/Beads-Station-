import { test, expect } from './helpers'

// Generates the README and release screenshots from a neutral sample project.
// Off by default: run with BS_SHOTS=docs/images/releases/vX.Y.Z npx playwright test readme-shots.
const out = process.env.BS_SHOTS
test.skip(!out, 'set BS_SHOTS to an output folder')

function bead(id: string, title: string, status: string, extra: Record<string, unknown> = {}, links: [string, string][] = []) {
  return {
    id, title, status, priority: 2, description: null, issue_type: 'task', assignee: null,
    created_at: '2026-10-20T09:00:00Z', updated_at: '2026-10-28T09:00:00Z', closed_at: status === 'closed' ? '2026-10-30T09:00:00Z' : null,
    dependency_count: 0, dependent_count: 0, comment_count: 0, labels: null, parent: null,
    dependencies: links.map(([to, type]) => ({ issue_id: id, depends_on_id: to, type })),
    ...extra,
  }
}
const epicA = 'site-1', epicB = 'site-2'
const child = (to: string): [string, string] => [to, 'parent-child']
const all = [
  bead(epicA, 'Launch the new pricing page', 'open', { issue_type: 'epic', priority: 1 }),
  bead('site-1.1', 'Write the plan comparison copy', 'closed', {}, [child(epicA)]),
  bead('site-1.2', 'Design the plan cards', 'in_progress', { priority: 1, description: 'Three plans side by side, with the recommended plan highlighted.' }, [child(epicA)]),
  bead('site-1.3', 'Build the responsive pricing table', 'open', {}, [child(epicA), ['site-1.1', 'blocks']]),
  bead('site-1.4', 'Add the annual billing toggle', 'open', {}, [child(epicA), ['site-1.3', 'blocks']]),
  bead('site-1.5', 'Check contrast and screen reader order', 'open', {}, [child(epicA), ['site-1.3', 'blocks']]),
  bead(epicB, 'Refresh the onboarding flow', 'open', { issue_type: 'epic', priority: 2 }),
  bead('site-2.1', 'Map the first-run steps', 'open', { priority: 1, description: 'List each step a new visitor sees and where they drop off.' }, [child(epicB)]),
  bead('site-2.2', 'Draft the welcome checklist', 'open', {}, [child(epicB), ['site-2.1', 'blocks']]),
  bead('site-3', 'Fix the footer link colour on dark backgrounds', 'open', { priority: 3 }),
  bead('site-4', 'Compress the hero image', 'open', { priority: 3, description: 'It is 2.4 MB today.' }),
]
const ready = all.filter(item => ['site-1.3', 'site-2.1', 'site-3', 'site-4'].includes(item.id))

test('capture the Designer', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(({ all, ready }) => {
    localStorage.setItem('beads-station.themePaletteId', 'fahrenheit')
    localStorage.setItem('beads-station.workspaces.v2', JSON.stringify({ openIds: ['proj-a'], activeId: 'proj-a' }))
    ;(window as any).__bsMockOverride = { bd_snapshot: { ready, all, no_db: false } }
  }, { all, ready })
  await page.goto('/?ui=designer')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  await expect(page.locator('.du-card').first()).toBeVisible()
  await page.screenshot({ path: `${out}/designer-requests.png` })
  await page.getByRole('button', { name: 'Bead map', exact: true }).click()
  await page.locator('[data-bs-bead-node="site-1.3"]').click()
  await expect(page.getByTestId('bead-inspector')).toBeVisible()
  await page.mouse.move(5, 5)
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${out}/designer-bead-map.png` })
})

test('capture the terminal workspace and About', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(() => {
    localStorage.setItem('beads-station.themePaletteId', 'fahrenheit')
    localStorage.setItem('beads-station.workspaces.v2', JSON.stringify({ openIds: ['proj-a', 'proj-b'], activeId: 'proj-a' }))
    localStorage.setItem('beads-station.lastConfirmed.proj-a', new Date().toISOString().slice(0, 10))
  })
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  await page.getByRole('button', { name: 'Split right', exact: true }).click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/terminal-splits.png` })
  await page.keyboard.press('Meta+,')
  await page.getByRole('button', { name: 'About', exact: true }).click()
  await page.getByTestId('app-version').waitFor()
  await page.screenshot({ path: `${out}/about.png` })
})

test('capture the Fahrenheit theme', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(({ all, ready }) => {
    localStorage.setItem('beads-station.workspaces.v2', JSON.stringify({ openIds: ['proj-a', 'proj-b'], activeId: 'proj-a' }))
    localStorage.setItem('beads-station.lastConfirmed.proj-a', new Date().toISOString().slice(0, 10))
    localStorage.setItem('beads-station.themePaletteId', 'fahrenheit')
    ;(window as any).__bsMockOverride = { bd_snapshot: { ready, all, no_db: false } }
  }, { all, ready })
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  await page.getByLabel('Beads view').selectOption('board')
  await expect(page.getByText('Design the plan cards').first()).toBeVisible()
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/developer-fahrenheit.png` })
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Open workspace' })).toBeVisible()
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/workspace-picker-fahrenheit.png` })
})

// v0.2.0 Designer Desk and terminal shots, Fahrenheit theme, sample project only.
const deskSessions = [
  { id: 'aaaa1111-0000-4000-8000-000000000001', provider: 'claude', title: 'Build the responsive pricing table', firstPrompt: 'Work on ticket site-1.3: Build the responsive pricing table. Read it with bd show first.', modifiedMs: Date.now() - 3 * 3_600_000, bytes: 4200 },
  { id: 'bbbb2222-0000-4000-8000-000000000002', provider: 'codex', title: 'Compress the hero image', firstPrompt: 'Compress the hero image', modifiedMs: Date.now() - 2 * 86_400_000, bytes: 900 },
  { id: 'cccc3333-0000-4000-8000-000000000003', provider: 'claude', title: 'Draft the welcome checklist', firstPrompt: 'Draft the welcome checklist for the onboarding flow', modifiedMs: Date.now() - 5 * 86_400_000, bytes: 1800 },
]
const deskTranscript = {
  id: deskSessions[0].id, provider: 'claude', truncated: false,
  usage: { input: 120, output: 2400, cacheRead: 1_500_000, cacheCreate: 800 },
  turns: [
    { role: 'user', at: null, blocks: [{ kind: 'text', text: 'Build the responsive pricing table so the three plans stack on narrow screens.' }], files: [], thinking: 0 },
    { role: 'assistant', at: null, thinking: 2, files: ['src/PricingTable.tsx', 'src/pricing.css'], blocks: [
      { kind: 'text', text: 'I built the **pricing table** as a grid. Below 640px the plans stack, and the recommended plan stays first.\n\n- Added `PricingTable.tsx` with three plan cards\n- Moved the breakpoint rules into `pricing.css`' },
      { kind: 'tool', name: 'Edit', summary: 'src/PricingTable.tsx', result: 'updated' },
    ] },
    { role: 'user', at: null, blocks: [{ kind: 'text', text: 'Good. Keep the highlight colour on the recommended plan.' }], files: [], thinking: 0 },
    { role: 'assistant', at: null, thinking: 0, files: [], blocks: [{ kind: 'text', text: 'Done. The recommended plan keeps its **accent border** at every width.' }] },
  ],
}

async function openDesk(page: import('@playwright/test').Page) {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(({ all, ready, sessions, transcript }) => {
    localStorage.setItem('beads-station.workspaces.v2', JSON.stringify({ openIds: ['proj-a'], activeId: 'proj-a' }))
    localStorage.setItem('beads-station.themePaletteId', 'fahrenheit')
    ;(window as any).__bsMockOverride = { bd_snapshot: { ready, all, no_db: false }, transcripts_list: sessions, transcript_read: transcript }
  }, { all, ready, sessions: deskSessions, transcript: deskTranscript })
  await page.goto('/?ui=designer')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
}

test('capture Designer History', async ({ page }) => {
  await openDesk(page)
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await page.getByRole('button', { name: /Build the responsive pricing table/ }).first().click()
  await expect(page.getByTestId('designer-history').locator('[data-role="assistant"]').first()).toBeVisible()
  await expect(page.getByTestId('history-meter')).toBeVisible()
  await page.mouse.move(5, 5)
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/designer-history.png` })
})

test('capture Designer Shelf', async ({ page }) => {
  await openDesk(page)
  await page.getByRole('button', { name: 'Pinned', exact: true }).click()
  const shelf = page.getByTestId('designer-shelf')
  for (const text of ['Keep the plan cards to three, with the middle one highlighted.', '~/Documents/notes/Pricing-brief.md', '~/Desktop/sample-project/src/PricingTable.tsx']) {
    await shelf.getByLabel('Add something to pin').fill(text)
    await shelf.getByRole('button', { name: 'Pin it', exact: true }).click()
  }
  await page.mouse.move(5, 5)
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/designer-shelf.png` })
})

test('capture a ticket with its sessions', async ({ page }) => {
  await openDesk(page)
  await page.getByRole('button', { name: 'Bead map', exact: true }).click()
  await page.locator('[data-bs-bead-node="site-1.3"]').dblclick()
  await expect(page.getByTestId('ticket-sessions')).toContainText('Sessions on this ticket')
  await page.mouse.move(5, 5)
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/designer-ticket-sessions.png` })
})

test('capture Restore split', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(({ all, ready }) => {
    localStorage.setItem('beads-station.workspaces.v2', JSON.stringify({ openIds: ['proj-a', 'proj-b'], activeId: 'proj-a' }))
    localStorage.setItem('beads-station.lastConfirmed.proj-a', new Date().toISOString().slice(0, 10))
    localStorage.setItem('beads-station.themePaletteId', 'fahrenheit')
    ;(window as any).__bsMockOverride = { bd_snapshot: { ready, all, no_db: false } }
  }, { all, ready })
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  await page.getByRole('button', { name: 'Split right', exact: true }).click()
  await page.getByRole('button', { name: 'Unsplit to tabs', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Restore split layout', exact: true })).toBeEnabled()
  await page.mouse.move(5, 5)
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/terminal-restore-split.png` })
})

// v0.2.1: Agents, Timeline and Session views.
for (const [view, file] of [['Agents', 'designer-agents'], ['Timeline', 'designer-timeline'], ['Session', 'designer-session']] as const) {
  test(`capture Designer ${view}`, async ({ page }) => {
    await openDesk(page)
    await page.getByRole('button', { name: view, exact: true }).click()
    await page.mouse.move(5, 5)
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${out}/${file}.png` })
  })
}
