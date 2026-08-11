import { test, expect } from './helpers'
import { boot, leader, termMirror } from './helpers'
import type { Page } from '@playwright/test'

// RV3-B (Code-8ro) live-verify: file-nav pane.
// leader-e spawns a virtualized file-tree pane (list_dir/read_file are mocked
// in mockIpc.ts); j/k move the tree cursor; opening a file shows a read-only
// preview (.bs-filepreview). No editor — preview only.

async function spawnFileNavPane(page: Page): Promise<void> {
  await leader(page)
  await page.keyboard.press('e')
  await page.waitForFunction(() => (window as any).__bsTerm?.activeIsFileNav === true)
}

test.beforeEach(async ({ page }) => {
  await boot(page)
})

test('leader-e spawns a file-nav pane rooted at the project path', async ({ page }) => {
  await spawnFileNavPane(page)
  const m = await termMirror(page)
  expect(m.activeIsFileNav).toBe(true)
  await expect(page.locator('.bs-filetree')).toBeVisible()
  // The mocked tree renders its rows (src / README.md / package.json).
  await expect(page.getByText('README.md', { exact: true })).toBeVisible()
})

// The FileTree keymap is a window listener active while the pane is active
// (FileTree.tsx:156-158); no element focus is needed. The cursor row carries
// `.bs-tree-row--active` + aria-selected="true".
async function activeRowName(page: Page): Promise<string> {
  return page.locator('.bs-filetree-row.bs-tree-row--active .bs-filetree-name').innerText()
}

test('j/k move the tree cursor', async ({ page }) => {
  await spawnFileNavPane(page)
  await expect(page.locator('.bs-filetree-row.bs-tree-row--active')).toHaveCount(1)

  const first = await activeRowName(page)
  await page.keyboard.press('j')
  const second = await activeRowName(page)
  expect(second).not.toBe(first)
  await page.keyboard.press('k')
  expect(await activeRowName(page)).toBe(first)
})

test('opening a file shows a read-only preview', async ({ page }) => {
  await spawnFileNavPane(page)
  // Gate on the active row existing so the pane's window keymap effect has
  // attached before we send keys (mirrors the j/k test).
  await expect(page.locator('.bs-filetree-row.bs-tree-row--active')).toHaveCount(1)

  // Row 0 is the project root (`beads-station`); j to `src`, j again to the
  // README.md file, then open with Enter.
  await page.keyboard.press('j')
  await page.keyboard.press('j')
  await expect(page.locator('.bs-filetree-row.bs-tree-row--active .bs-filetree-name')).toHaveText('README.md')
  await page.keyboard.press('Enter')

  const preview = page.locator('.bs-filepreview')
  await expect(preview).toBeVisible()
  await expect(preview.locator('.bs-filepreview-body')).toContainText('Mock preview body')
  // Read-only: the preview body is a <pre>, not an editable field.
  await expect(preview.locator('textarea, input, [contenteditable="true"]')).toHaveCount(0)
})
