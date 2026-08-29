import { test, expect, boot, leader } from './helpers'

// Code-mkv (RV1-layout) live-verify: draggable split seam + per-project layout
// persistence across reload. The seam ([data-bs-split-seam]) writes a Split's
// ratio; the whole per-project pane surface is persisted to localStorage
// (beads-station.termPanes) and rehydrated on reload — panes never remount.

test.beforeEach(async ({ page }) => {
  await boot(page)
})

/** leader-v splits the active pane vertically (useVimNav.ts:344). The leader
 *  split bindings are gated on terminal focus, so enter the terminal first
 *  (Cmd/Ctrl+Enter fullscreen focus — Code-qqt) before arming the leader. */
async function splitVertical(page: import('@playwright/test').Page): Promise<void> {
  const before = await page.evaluate(() => (window as any).__bsTerm?.paneCount)
  await page.keyboard.press('Control+Enter')
  await page.waitForFunction(() => (window as any).__bsVim?.focused === 'terminal')
  await leader(page)
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
  const after = await page.evaluate(() => (window as any).__bsTerm?.paneCount)
  expect(after).toBe(before)
})
