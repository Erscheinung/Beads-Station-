import { test, expect } from './helpers'
import { boot, leader, spawnAgentPane, termMirror, invokeLog } from './helpers'
import type { Page } from '@playwright/test'

// RV3-C (Code-ia4) live-verify: nav -> agent glue.
// With an agent pane present, pressing `s` on a file row in a filenav pane
// sends that file's path to the target agent bridge via claude_send.
// FileTree.tsx:132-142 -> invoke('claude_send', { projectId: bridge,
// text: 'Please look at this file: <path>' }).

async function spawnFileNavPane(page: Page): Promise<void> {
  await leader(page)
  await page.keyboard.press('e')
  await page.waitForFunction(() => (window as any).__bsTerm?.activeIsFileNav === true)
  await expect(page.locator('.bs-filetree-row.bs-tree-row--active')).toHaveCount(1)
}

test('pressing s on a file row sends its path to the agent bridge via claude_send', async ({ page }) => {
  await boot(page)

  // An agent pane must exist as the send target; capture its bridge id.
  await spawnAgentPane(page)
  const bridge = (await termMirror(page)).activeAgentBridgeId
  expect(bridge).toBeTruthy()

  // Now open a filenav pane and select the README.md file row by clicking it
  // (onClick sets the cursor directly — robust against focus routing between
  // the two panes). Then `s` sends the cursor path to the agent.
  await spawnFileNavPane(page)
  const readmeRow = page
    .locator('.bs-filetree-row')
    .filter({ has: page.locator('.bs-filetree-name', { hasText: 'README.md' }) })
  await readmeRow.click()
  await expect(page.locator('.bs-filetree-row.bs-tree-row--active .bs-filetree-name')).toHaveText('README.md')

  // Send to the agent.
  await page.keyboard.press('s')

  // claude_send fired with the README.md path aimed at the agent bridge.
  await expect
    .poll(async () => {
      const log = await invokeLog(page)
      return log.some(
        e =>
          e.cmd === 'claude_send' &&
          e.args?.projectId === bridge &&
          typeof e.args?.text === 'string' &&
          (e.args.text as string).includes('README.md'),
      )
    })
    .toBe(true)
})
