import { test, expect, type Page } from '@playwright/test'

// Shared boot + drive helpers for the R12 live-verify specs.
// The app runs in browser-mock mode (VITE_LIVE_MOCK=1); see src/test-harness/.

const PROJECT_IDS = ['proj-a', 'proj-b']

/** Bypass the MorningConfirm gate by pre-seeding today's date into the same
 *  localStorage key shouldConfirm() reads (MorningConfirm.tsx:114). Computed in
 *  the browser so it always matches the app's own todayYMD(). */
export async function seedConfirmed(page: Page): Promise<void> {
  await page.addInitScript((ids: string[]) => {
    if (localStorage.getItem('beads-station.workspaces.v2') === null) localStorage.setItem('beads-station.workspaces.v2', JSON.stringify({ openIds: ids, activeId: ids[0] }))
    const d = new Date()
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    for (const id of ids) localStorage.setItem('beads-station.lastConfirmed.' + id, ymd)
  }, PROJECT_IDS)
}

/** Navigate, wait for the mock IPC layer, and confirm the shell rendered.
 *  Also waits for the vim/term mirrors + keydown listener to be live, so the
 *  first keypress isn't dropped before useVimNav's effect attaches. */
export async function boot(page: Page): Promise<void> {
  await seedConfirmed(page)
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  await expect(page.locator('#root')).toBeVisible()
  await page.getByRole('button', { name: 'Start Claude chat', exact: true }).click()
  await page.waitForFunction(
    () => !!(window as any).__bsVim && !!(window as any).__bsTerm,
  )
}

/** Read the app's live pane-tree mirror (termPanes.ts:155-175). */
export async function termMirror(page: Page): Promise<{
  insert: boolean
  paneCount: number
  activeIsAgent: boolean
  activeAgentBridgeId: string
  activeIsFileNav: boolean
}> {
  return page.evaluate(() => (window as any).__bsTerm)
}

/** Fire a Tauri event into the app via the mock emitter. */
export async function emit(page: Page, channel: string, payload: unknown): Promise<void> {
  await page.evaluate(
    ([ch, p]) => (window as any).__bsMockEmit(ch, p),
    [channel, payload] as const,
  )
}

/**
 * Fire an event until the app shows it reacted. Listeners attach
 * asynchronously after mount, so one emit right after boot can be lost.
 */
export async function emitUntil(page: Page, events: Array<[channel: string, payload: unknown]>, reacted: () => Promise<void>): Promise<void> {
  await expect(async () => {
    for (const [channel, payload] of events) await emit(page, channel, payload)
    await reacted()
  }).toPass({ timeout: 10_000 })
}

/** The ordered log of invokes the app made (recorded by the mock). */
export async function invokeLog(
  page: Page,
): Promise<Array<{ cmd: string; args: Record<string, unknown> | undefined }>> {
  return page.evaluate(() => (window as any).__bsInvokeLog ?? [])
}

/** Arm the leader chord (Space). Works from any focus — but if an editable
 *  (the agent input) holds focus, the keydown bypass (useVimNav.ts:391) would
 *  swallow the Space before it arms the leader. Blur first so Space lands on
 *  the window listener. Mirrors the app's own leader-chord blur (line 377). */
export async function leader(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
  await page.keyboard.press('Space')
}

/** Spawn a fresh agent pane via leader-a. The global leader menu handles 'a'
 *  from any focus (useVimNav.ts:435 → agent:spawn), and App.tsx moves focus to
 *  'terminal' on spawn (App.tsx:69). Waits for a new [data-bs-agent-pane] to
 *  appear (agent-pane count, not total paneCount which includes the shell). */
export async function spawnAgentPane(page: Page): Promise<void> {
  const before = await page.locator('[data-bs-agent-pane]').count()
  await leader(page)
  await page.keyboard.press('a')
  await expect(page.locator('[data-bs-agent-pane]')).toHaveCount(before + 1)
  // A mounted pane focuses on the next animation frame. Wait for that before
  // the next helper blurs it; otherwise autofocus can race the leader chord.
  await page.waitForFunction(() => {
    const bridge = (window as any).__bsTerm?.activeAgentBridgeId
    return !!bridge && document.activeElement?.closest('[data-bs-agent-pane]')?.getAttribute('data-bs-agent-pane') === bridge
  })
}

export { test, expect }
