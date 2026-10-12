import { test, expect, boot, leader } from './helpers'

// Code-mkv (RV1-layout) live-verify: draggable split seam + per-project layout
// persistence across reload. The seam ([data-bs-split-seam]) writes a Split's
// ratio; the whole per-project pane surface is persisted to localStorage
// (beads-station.termPanes) and rehydrated on reload — panes never remount.
//
// Code-6k4: reload-restore soak — 20 reload cycles with a split + custom ratio,
// asserting paneCount stable, split ratio preserved, no orphan xterm instances,
// and JS heap not growing unboundedly.

test.beforeEach(async ({ page }) => {
  await boot(page)
})

/** leader-v splits the active pane vertically (useVimNav.ts:344). The leader
 *  split bindings are gated on terminal focus, so enter the terminal first
 *  (Cmd/Ctrl+Shift+Enter fullscreen focus — Code-qqt) before arming the leader. */
async function splitVertical(page: import('@playwright/test').Page): Promise<void> {
  const before = await page.evaluate(() => (window as any).__bsTerm?.paneCount)
  await page.keyboard.press('Control+Shift+Enter')
  await page.waitForFunction(() => (window as any).__bsVim?.focused === 'terminal')
  // Fullscreen hands the keyboard to the shell (Code-gya.2), so a bare Space
  // is typed, not a leader. Cmd+P arms the leader from the shell.
  await page.keyboard.press('Meta+p')
  await page.keyboard.press('v')
  await page.waitForFunction(
    (n) => (window as any).__bsTerm?.paneCount === n + 1,
    before,
  )
}

test('a split renders a draggable seam between the two halves', async ({ page }) => {
  await splitVertical(page)
  await expect(page.locator('[data-bs-split-seam]')).toHaveCount(1)
})

test('dragging the seam changes the split ratio without remounting panes', async ({ page }) => {
  await splitVertical(page)
  const seam = page.locator('[data-bs-split-seam]').first()
  const box = await seam.boundingBox()
  if (!box) throw new Error('seam not visible')

  const paneCountBefore = await page.evaluate(() => (window as any).__bsTerm?.paneCount)

  // Drag the seam left by ~120px (grows the right half / shrinks child a).
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx - 120, cy, { steps: 8 })
  await page.mouse.up()

  // The persisted surface must now carry a ratio away from 0.5. The persist is
  // debounced (150ms), so poll until it flushes rather than reading eagerly.
  const readRatio = () => {
    const raw = localStorage.getItem('beads-station.termPanes')
    if (!raw) return null
    const parsed = JSON.parse(raw)
    for (const s of Object.values<any>(parsed.projects ?? {})) {
      const walk = (n: any): number | null => {
        if (!n || n.kind !== 'split') return null
        if (Math.abs(n.ratio - 0.5) > 0.01) return n.ratio
        return walk(n.a) ?? walk(n.b)
      }
      const r = walk(s.tabs?.[0]?.root)
      if (r != null) return r
    }
    return null
  }
  await page.waitForFunction(() => {
    const raw = localStorage.getItem('beads-station.termPanes')
    if (!raw) return false
    const parsed = JSON.parse(raw)
    for (const s of Object.values<any>(parsed.projects ?? {})) {
      const walk = (n: any): boolean => {
        if (!n || n.kind !== 'split') return false
        if (Math.abs(n.ratio - 0.5) > 0.01) return true
        return walk(n.a) || walk(n.b)
      }
      if (walk(s.tabs?.[0]?.root)) return true
    }
    return false
  })
  const ratio = await page.evaluate(readRatio)
  expect(ratio).not.toBeNull()
  expect(ratio!).toBeLessThan(0.5)

  // No remount: pane count is unchanged by a ratio drag.
  const paneCountAfter = await page.evaluate(() => (window as any).__bsTerm?.paneCount)
  expect(paneCountAfter).toBe(paneCountBefore)
})

test('the pane tree is restored per project across a reload', async ({ page }) => {
  await splitVertical(page) // 2 panes now
  const before = await page.evaluate(() => (window as any).__bsTerm?.paneCount)
  expect(before).toBeGreaterThanOrEqual(2)

  // Wait for the debounced persist (150ms) to flush before reloading.
  await page.waitForFunction(
    () => !!localStorage.getItem('beads-station.termPanes'),
  )
  await page.waitForTimeout(250)

  await page.reload()
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  await page.waitForFunction(() => !!(window as any).__bsTerm)

  // The restored surface has the same pane count (tree rehydrated, not reset).
  await expect.poll(() => page.evaluate(() => (window as any).__bsTerm?.paneCount)).toBe(before)
})

// ── Code-6k4: reload-restore soak ────────────────────────────────────────────

/** Read the first non-0.5 split ratio from localStorage, or null if none. */
function readPersistedRatio(page: import('@playwright/test').Page): Promise<number | null> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('beads-station.termPanes')
    if (!raw) return null
    const parsed = JSON.parse(raw)
    for (const s of Object.values<any>(parsed.projects ?? {})) {
      const walk = (n: any): number | null => {
        if (!n || n.kind !== 'split') return null
        if (Math.abs(n.ratio - 0.5) > 0.01) return n.ratio
        return walk(n.a) ?? walk(n.b)
      }
      const r = walk(s.tabs?.[0]?.root)
      if (r != null) return r
    }
    return null
  })
}

test('reload-restore soak: paneCount + ratio stable across 20 cycles, no orphan xterm', async ({ page }) => {
  // Establish a split with a custom (non-default) ratio.
  await splitVertical(page)
  const seam = page.locator('[data-bs-split-seam]').first()
  const box = await seam.boundingBox()
  if (!box) throw new Error('seam not visible')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx - 100, cy, { steps: 6 })
  await page.mouse.up()

  // Wait for ratio + paneCount to settle in localStorage.
  await page.waitForFunction(() => {
    const raw = localStorage.getItem('beads-station.termPanes')
    if (!raw) return false
    const parsed = JSON.parse(raw)
    for (const s of Object.values<any>(parsed.projects ?? {})) {
      const walk = (n: any): boolean => {
        if (!n || n.kind !== 'split') return false
        if (Math.abs(n.ratio - 0.5) > 0.01) return true
        return walk(n.a) || walk(n.b)
      }
      if (walk(s.tabs?.[0]?.root)) return true
    }
    return false
  })

  const expectedPaneCount = await page.evaluate(() => (window as any).__bsTerm?.paneCount)
  const expectedRatio = await readPersistedRatio(page)
  expect(expectedPaneCount).toBeGreaterThanOrEqual(2)
  expect(expectedRatio).not.toBeNull()

  const heapSamples: number[] = []

  const CYCLES = 20
  for (let i = 0; i < CYCLES; i++) {
    await page.reload()
    await page.waitForFunction(() => (window as any).__bsMockReady === true)
    await page.waitForFunction(() => !!(window as any).__bsTerm)

    // The mirror starts at one pane and reaches the restored count once the
    // workspace surface is activated, so wait for it rather than sampling once.
    await expect.poll(() => page.evaluate(() => (window as any).__bsTerm?.paneCount), { message: `cycle ${i + 1}: paneCount` }).toBe(expectedPaneCount)

    const ratio = await readPersistedRatio(page)
    expect(ratio, `cycle ${i + 1}: ratio present`).not.toBeNull()
    expect(Math.abs(ratio! - expectedRatio!), `cycle ${i + 1}: ratio stable`).toBeLessThan(0.02)

    // No orphan xterm containers — one per leaf pane, no extras.
    const xtermCount = await page.locator('.xterm-screen').count()
    expect(xtermCount, `cycle ${i + 1}: xterm count`).toBeLessThanOrEqual(expectedPaneCount)

    if (i % 5 === 0) {
      const heap = await page.evaluate(() => (performance as any).memory?.usedJSHeapSize ?? 0)
      heapSamples.push(heap)
    }
  }

  // Heap must not grow more than 3x between first and last sample (leak guard).
  // In mock mode the xterm instances are thin; 3x is generous for 20 reloads.
  if (heapSamples.length >= 2) {
    const first = heapSamples[0]
    const last = heapSamples[heapSamples.length - 1]
    expect(last, 'heap growth bounded across 20 reloads').toBeLessThan(first * 3 + 30_000_000)
  }
}, { timeout: 60_000 })

test('focus-toggle soak: 20 enter/exit cycles — paneCount stable, no orphan xterm', async ({ page }) => {
  await splitVertical(page)
  // splitVertical leaves focused === 'terminal'; exit first so we start from 'board'.
  await page.keyboard.press('Control+Shift+Enter')
  await page.waitForFunction(() => (window as any).__bsVim?.focused !== 'terminal')

  const expectedPaneCount = await page.evaluate(() => (window as any).__bsTerm?.paneCount)
  expect(expectedPaneCount).toBeGreaterThanOrEqual(2)

  for (let i = 0; i < 20; i++) {
    // Enter terminal focus (focused → 'terminal').
    await page.keyboard.press('Control+Shift+Enter')
    await page.waitForFunction(() => (window as any).__bsVim?.focused === 'terminal')

    // Exit terminal focus (focused → 'board').
    await page.keyboard.press('Control+Shift+Enter')
    await page.waitForFunction(() => (window as any).__bsVim?.focused !== 'terminal')

    const paneCount = await page.evaluate(() => (window as any).__bsTerm?.paneCount)
    expect(paneCount, `toggle ${i + 1}: paneCount`).toBe(expectedPaneCount)

    const xtermCount = await page.locator('.xterm-screen').count()
    expect(xtermCount, `toggle ${i + 1}: no orphan xterm`).toBeLessThanOrEqual(expectedPaneCount)
  }
}, { timeout: 30_000 })
