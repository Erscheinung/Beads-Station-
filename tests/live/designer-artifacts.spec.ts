import { test, expect } from '@playwright/test'

const runId = 'proj-a:Code-aaa:attempt-artifact'
const identity = { workspaceId: 'proj-a', ticketId: 'Code-aaa', runId, attemptId: 'attempt-artifact' }
const revision = {
  schemaVersion: 1, revisionId: 'rev-fixture', capturedAt: 1_800_000_000_000, ...identity,
  workspacePath: '/tmp/beads-station', sourceRevision: '0123456789abcdef', revisionHash: 'hash-fixture',
  files: [{ path: 'index.html', status: 'M', size: 83, contentHash: 'file-hash', content: '<script>window.parent.__artifactExecuted = true</script><main>memory game</main>', binary: false, truncated: false }],
  diff: '--- index.html\n+++ index.html\n+<main>memory game</main>',
  validation: [],
}
const approval = { ...identity, revisionId: revision.revisionId, revisionHash: revision.revisionHash, approvedAt: 1_800_000_000_100 }

async function bootReview(page: import('@playwright/test').Page, verified = true) {
  await page.addInitScript(({ identity, revision, approval, verified }) => {
    localStorage.setItem('beads-station.workspaces.v2', JSON.stringify({ openIds: ['proj-a'], activeId: 'proj-a' }))
    localStorage.setItem('beads-station.designer-runs.v1', JSON.stringify([{
      key: 'proj-a:Code-aaa', ...identity, cwd: '/tmp/beads-station', provider: 'codex', status: 'needs_review', output: ['fixture finished'],
    }]))
    ;(window as any).__bsMockOverride = {
      native_run_snapshot: [{ ...identity, cwd: '/tmp/beads-station', provider: 'codex', status: 'needs_review', events: [{ seq: 1, kind: 'status', status: 'needs_review' }] }],
      artifact_review: { revision: null, approval: null },
      artifact_capture: revision,
      artifact_verify: verified,
      artifact_approve: approval,
    }
  }, { identity, revision, approval, verified })
  await page.goto('/?ui=designer')
  await page.waitForFunction(() => (window as any).__bsMockReady === true)
  await page.getByRole('button', { name: 'Bead map', exact: true }).click()
  await page.locator('[data-bs-bead-node][data-bs-bead-state="ready"]').first().dblclick()
  await expect(page.getByTestId('designer-ticket-run')).toBeVisible()
}

test('captures, previews, and approves the exact Designer artifact revision', async ({ page }) => {
  await bootReview(page)
  await page.getByRole('button', { name: 'Capture artifact', exact: true }).click()
  const review = page.getByTestId('designer-artifact-review')
  await expect(review).toContainText('rev-fixture')
  await expect(review).toContainText('index.html')
  await expect(review).toContainText('memory game')
  await expect(review).toContainText('No independent checks were captured')
  expect(await page.evaluate(() => (window as any).__artifactExecuted)).toBeUndefined()
  await expect(review.locator('iframe, script')).toHaveCount(0)
  await page.getByRole('button', { name: 'Approve revision', exact: true }).click()
  await expect(review).toContainText('Approved')
  const approvalCall = await page.evaluate(() => (window as any).__bsInvokeLog.find((entry: any) => entry.cmd === 'artifact_approve'))
  expect(approvalCall.args.args.revision).toEqual({ ...identity, revisionId: 'rev-fixture', revisionHash: 'hash-fixture' })
  expect(approvalCall.args.args.revision.files).toBeUndefined()
})

test('a changed workspace rejects approval and leaves recapture available', async ({ page }) => {
  await bootReview(page, false)
  await page.getByRole('button', { name: 'Capture artifact', exact: true }).click()
  await page.getByRole('button', { name: 'Approve revision', exact: true }).click()
  await expect(page.getByText(/Workspace changed after capture/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Recapture artifact', exact: true })).toBeEnabled()
})
