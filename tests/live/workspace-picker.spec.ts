import { test, expect } from '@playwright/test'

for (const mode of ['', '?ui=designer']) {
  test(`fresh launch discovers without opening workspaces or agents ${mode}`, async ({ page }) => {
    await page.goto(`/${mode}`)
    await expect(page.getByRole('heading', { name: 'Your work starts here.' })).toBeVisible()
    await expect(page.getByRole('option', { name: /Beads-Station.*\/tmp\/beads-station/ })).toBeVisible()
    const starts = await page.evaluate(() => (window as any).__bsInvokeLog.filter((e: any) => ['pty_spawn', 'claude_start', 'projects_open'].includes(e.cmd)))
    expect(starts).toEqual([])
    await page.getByRole('option', { name: /Beads-Station.*\/tmp\/beads-station/ }).click()
    await expect(page.getByRole('heading', { name: 'Your work starts here.' })).toHaveCount(0)
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('beads-station.workspaces.v2')!).openIds)).toEqual(['proj-a'])
    const agents = await page.evaluate(() => (window as any).__bsInvokeLog.filter((e: any) => e.cmd === 'claude_start'))
    expect(agents).toEqual([])
  })
}

test('open, close and reload preserves only explicitly opened workspaces', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('option', { name: /Beads-Station.*\/tmp\/beads-station/ }).click()
  await expect(page.locator('.bs-tabstrip .bs-tab')).toHaveCount(1)
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
  await page.getByRole('option', { name: /Nexus.*\/tmp\/nexus/ }).click()
  await expect(page.locator('.bs-tabstrip .bs-tab')).toHaveCount(2)
  await page.getByRole('button', { name: 'Close workspace Beads-Station' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true }).click()
  await page.reload()
  await expect(page.locator('.bs-tabstrip .bs-tab')).toHaveCount(1)
  await expect(page.locator('.bs-tabstrip .bs-tab')).toHaveText('Nexus')
  await expect(page.getByRole('button', { name: 'Start Claude chat' })).toBeVisible()
})

test('missing discovery roots leave folder opening and settings usable', async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as any).__bsMockOverride = { projects_list: { projects: [], roots: ['/missing'], warnings: ['/missing: No such file or directory'] } }
  })
  await page.goto('/')
  await page.getByText('Discovery roots', { exact: false }).click()
  await expect(page.getByLabel('Discovery roots', { exact: true })).toHaveValue('/missing')
  await page.getByRole('combobox', { name: 'Find a workspace or enter a path' }).fill('/tmp/new-folder')
  await page.getByRole('button', { name: 'Open folder', exact: false }).click()
  await expect(page.locator('.bs-tabstrip .bs-tab')).toHaveText('new-folder')
})

test('primary workspace entry filters discovered projects and Enter opens only the best match', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Your work starts here.' })).toBeVisible()

  const folder = page.getByRole('combobox', { name: 'Find a workspace or enter a path' })
  await folder.fill('Nex')
  await expect(page.locator('.workspace-picker__project')).toHaveCount(1)
  await expect(page.locator('.workspace-picker__project')).toContainText('Nexus')
  await expect(page.locator('.workspace-picker__project')).not.toContainText('Beads-Station')
  await folder.press('Enter')

  await expect(page.locator('.bs-tabstrip .bs-tab')).toHaveText('Nexus')
  const opens = await page.evaluate(() => (window as any).__bsInvokeLog.filter((e: any) => e.cmd === 'projects_open'))
  expect(opens).toHaveLength(1)
  expect(opens[0].args.path).toBe('/tmp/nexus')
})

test('workspace modal accepts real key presses after terminal focus', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('option', { name: /Beads-Station.*\/tmp\/beads-station/ }).click()
  await page.locator('.xterm textarea').first().focus()
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
  const folder = page.getByRole('combobox', { name: 'Find a workspace or enter a path' })
  await folder.click()
  await folder.pressSequentially('/tmp/a folder')
  await expect(folder).toHaveValue('/tmp/a folder')
  await folder.press('Shift+Tab')
  await expect(page.getByRole('dialog')).toBeVisible()
  await folder.press('Enter')
  await expect(page.locator('.bs-tabstrip .bs-tab').last()).toHaveText('a folder')
})

test('the clone address field fills the row beside its button', async ({ page }) => {
  await page.goto('/')
  await page.getByText('Clone a repository').click()
  const field = await page.getByLabel('Repository address').boundingBox()
  const button = await page.getByRole('button', { name: 'Clone', exact: true }).boundingBox()
  expect(field!.width).toBeGreaterThan(400)
  expect(Math.abs(field!.y - button!.y)).toBeLessThan(12)
})
