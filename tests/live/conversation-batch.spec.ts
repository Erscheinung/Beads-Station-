import { test, expect, type Page } from '@playwright/test'

// Code-7xc.9 — conversations: History follows a growing session and can fork
// it, and a running Session is reachable from History. Mock IPC only.

const SESSION = 'aaaa1111-0000-4000-8000-000000000001'

async function openDesigner(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('beads-station.workspaces.v2', JSON.stringify({ openIds: ['proj-a'], activeId: 'proj-a' }))
  })
  await page.goto('/?ui=designer')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
}

const calls = (page: Page, cmd: string) =>
  page.evaluate(name => (window as any).__bsInvokeLog.filter((entry: any) => entry.cmd === name), cmd)

function transcript(count: number) {
  return {
    id: SESSION, provider: 'claude', truncated: false, usage: null,
    turns: Array.from({ length: count }, (_, i) => i % 2 === 0
      ? { role: 'user', at: null, blocks: [{ kind: 'text', text: `Question number ${i}` }], files: [], thinking: 0 }
      : { role: 'assistant', at: null, blocks: [{ kind: 'text', text: `Answer number ${i}\n\n${'filler line\n\n'.repeat(12)}` }], files: [], thinking: 0 }),
  }
}

test('History shows a New turns pill when the session grows while scrolled up', async ({ page }) => {
  await openDesigner(page)
  await page.evaluate(([t]) => {
    const w = window as any
    w.__bsMockOverride = { ...(w.__bsMockOverride ?? {}), transcript_read: t, transcript_stamp: { modifiedMs: Date.now() - 3_600_000, bytes: 100 } }
  }, [transcript(8)] as const)
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await page.getByRole('button', { name: /Fix the header spacing/ }).click()
  const scroll = page.getByTestId('history-scroll')
  await expect(scroll).toContainText('Answer number 7')
  await expect(page.getByTestId('history-running')).toHaveCount(0)
  await expect(page.getByTestId('history-last-turn')).toContainText('last turn')

  await scroll.evaluate(element => { element.scrollTop = 0 })
  await page.evaluate(([t]) => {
    const w = window as any
    w.__bsMockOverride = { ...w.__bsMockOverride, transcript_read: t, transcript_stamp: { modifiedMs: Date.now(), bytes: 400 } }
  }, [transcript(10)] as const)
  const pill = page.getByTestId('history-new-turns')
  await expect(pill).toBeVisible({ timeout: 10_000 })
  await expect(pill).toContainText('(2)')
  // The file just changed: it is running now.
  await expect(page.getByTestId('history-running')).toBeVisible()

  await pill.click()
  await expect(pill).toHaveCount(0)
  await expect(scroll).toContainText('Answer number 9')
  expect((await calls(page, 'pty_spawn')).length).toBe(0)
})

test('with a Session already running, History offers Go to running session and Resume in a new pane', async ({ page }) => {
  await openDesigner(page)
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await page.getByRole('button', { name: /Fix the header spacing/ }).click()
  await page.getByRole('button', { name: 'Resume in Session', exact: true }).click()
  await expect(page.locator('[data-terminal-pane="designer:proj-a"]')).toBeVisible()
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Resume in Session', exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'Go to running session' }).click()
  await expect(page.locator('[data-terminal-pane="designer:proj-a"]')).toBeVisible()
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await page.getByRole('button', { name: /Fix the header spacing/ }).click()

  const before = (await calls(page, 'pty_spawn')).length
  await page.getByRole('button', { name: 'Resume in a new pane' }).click()
  await expect.poll(async () => (await calls(page, 'pty_spawn')).length).toBeGreaterThan(before)
})

test('Fork here forks the whole session into a new split and says so', async ({ page }) => {
  await openDesigner(page)
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await page.getByRole('button', { name: /Fix the header spacing/ }).click()
  const history = page.getByTestId('designer-history')
  await expect(history.locator('[data-role="assistant"]')).toHaveCount(1)
  // Only your own prompts offer it.
  await expect(history.getByRole('button', { name: 'Fork here' })).toHaveCount(1)
  const before = (await calls(page, 'pty_spawn')).length
  await history.getByRole('button', { name: 'Fork here' }).click()
  await expect(page.getByText('Forked from the whole session; Claude can’t fork at a single message.')).toBeVisible()
  await expect.poll(async () => (await calls(page, 'pty_spawn')).length).toBeGreaterThan(before)
})

async function openTerminalWith(page: Page, panes: unknown, storage: Record<string, string> = {}) {
  await page.addInitScript(([tree, extra]) => {
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    localStorage.setItem('beads-station.workspaces.v2', JSON.stringify({ openIds: ['proj-a'], activeId: 'proj-a' }))
    localStorage.setItem('beads-station.session-preferences', JSON.stringify({ chatSurface: 'terminal' }))
    localStorage.setItem('beads-station.termPanes', JSON.stringify(tree))
    for (const [key, value] of Object.entries(extra as Record<string, string>)) localStorage.setItem(key, value)
  }, [panes, storage] as const)
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
}

test('a restored chat pane shows its conversation from the transcript and starts nothing until Continue', async ({ page }) => {
  const panes = { v: 2, projects: { 'proj-a': {
    tabs: [{ id: 'tab800', activePaneId: 'pane801', root: { kind: 'leaf', paneId: 'pane801', ptyId: 3, cwd: '/tmp/sample-project',
      agent: { bridgeId: 'agent802', projectId: 'proj-a', sessionId: 'alloc', provider: 'claude', permissionMode: 'plan' } } }],
    activeTabId: 'tab800', insert: false,
  } } }
  await openTerminalWith(page, panes, { 'bs.claude.session:agent802': SESSION })
  const pane = page.locator('[data-restored-provider="agent802"]')
  await expect(pane.getByTestId('restored-conversation')).toContainText('Fix the header spacing')
  await expect(pane.locator('[data-role="assistant"] .bs-md strong')).toHaveText('header')
  await expect(pane.getByRole('button', { name: 'Continue' })).toBeVisible()
  await expect(pane.getByRole('button', { name: 'Start new session' })).toBeVisible()
  expect((await calls(page, 'claude_start')).length).toBe(0)
  expect((await calls(page, 'pty_spawn')).length).toBe(0)

  await pane.getByRole('button', { name: 'Continue' }).click()
  await expect(page.locator('[data-restored-provider="agent802"]')).toHaveCount(0)
})
