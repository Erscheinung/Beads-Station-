import { test, expect, boot, spawnAgentPane, emit, termMirror, invokeLog } from './helpers'

// Code-ape - agent-pane a/d tool approval keys.
// Fix (commit 1627f11) has TWO resolution paths depending on focus:
//   (1) agent input focused -> the input's own onKeyDown (ClaudeChat.tsx:495),
//       guarded by topmostPending && input empty.
//   (2) focus NOT on an editable -> the window keydown listener
//       (ClaudeChat.tsx:365), gated on active===true for agent panes.
// Both are verified here. The pending card renders from a permission_request
// frame emitted on claude_event:<bridge>; extractApproval (ClaudeChat.tsx:73)
// parses it.
//
// What "resolved" looks like in the DOM: the ApprovalCard is filtered out the
// instant approvalStates flips off 'pending' (ClaudeChat.tsx:451 -
// isApprovalPending returns false), so the pending card (which carries
// data-request-id, ApprovalCard.tsx:79) DISAPPEARS. The resolved
// "[ok] approved" variant (ApprovalCard.tsx:38) is unreachable for
// permission_request frames because the card unmounts first. So the assertable
// signal of a successful a/d is: the pending card vanishes AND claude_approve /
// claude_deny fired with the requestId. (Follow-up: the resolved variant never
// shows for permission_request frames - worth a low-pri UX ticket.)

type Page = import('@playwright/test').Page

const paneSel = (bridge: string) => `[data-bs-agent-pane="${bridge}"]`
const pending = (page: Page, bridge: string, id: string) =>
  page.locator(`${paneSel(bridge)} [data-request-id="${id}"]`)

/** Assert the app fired the given approval RPC for the requestId. */
async function expectResolved(page: Page, cmd: 'claude_approve' | 'claude_deny', requestId: string) {
  const log = await invokeLog(page)
  const hit = log.find(e => e.cmd === cmd && e.args?.requestId === requestId)
  expect(hit, `${cmd} should have fired for ${requestId}`).toBeTruthy()
}

/** Emit a pending-approval frame to the given bridge and wait for the card. */
async function emitApproval(page: Page, bridge: string, requestId: string) {
  await emit(page, `claude_event:${bridge}`, {
    type: 'permission_request',
    request_id: requestId,
    tool_name: 'Bash',
    input: { command: 'echo hello' },
  })
  await expect(pending(page, bridge, requestId)).toBeVisible()
}

/** Bridge id of the currently-active agent pane (owns focus, window listener
 *  armed). Read from the live term mirror. */
async function agentBridge(page: Page): Promise<string> {
  const bridge = (await termMirror(page)).activeAgentBridgeId
  expect(bridge, 'active pane should be an agent with a bridge id').toBeTruthy()
  return bridge
}

test.beforeEach(async ({ page }) => {
  await boot(page)
  await spawnAgentPane(page)
})

test("path 1 - 'a' resolves approval when the agent input is focused", async ({ page }) => {
  const bridge = await agentBridge(page)
  await emitApproval(page, bridge, 'req-approve-1')

  // Agent input holds focus in normal use; ensure it's focused and empty.
  const input = page.locator(`${paneSel(bridge)} [data-bs-agent-input]`)
  await input.focus()
  await expect(input).toHaveValue('')

  await page.keyboard.press('a')

  await expect(pending(page, bridge, 'req-approve-1')).toHaveCount(0)
  await expectResolved(page, 'claude_approve', 'req-approve-1')
})

test("path 1 - 'd' denies approval when the agent input is focused", async ({ page }) => {
  const bridge = await agentBridge(page)
  await emitApproval(page, bridge, 'req-deny-1')

  const input = page.locator(`${paneSel(bridge)} [data-bs-agent-input]`)
  await input.focus()
  await expect(input).toHaveValue('')

  await page.keyboard.press('d')

  await expect(pending(page, bridge, 'req-deny-1')).toHaveCount(0)
  await expectResolved(page, 'claude_deny', 'req-deny-1')
})

test("path 1 - typing after a non-trigger char does NOT resolve (guard: input must be empty)", async ({ page }) => {
  const bridge = await agentBridge(page)
  await emitApproval(page, bridge, 'req-guard-1')

  const input = page.locator(`${paneSel(bridge)} [data-bs-agent-input]`)
  await input.focus()
  // Type a non-a/d char first so the input is non-empty; from here 'a'/'d' must
  // type normally (the onKeyDown guard requires input.length===0 to intercept).
  await input.type('question about apples and dates')

  // The card stays pending and the full text (incl. its a's and d's) landed.
  await expect(input).toHaveValue('question about apples and dates')
  await expect(pending(page, bridge, 'req-guard-1')).toBeVisible()
  const log = await invokeLog(page)
  expect(log.some(e => e.cmd === 'claude_approve' || e.cmd === 'claude_deny')).toBe(false)
})

test("path 2 - 'a' resolves via the window listener when focus is NOT on the input", async ({ page }) => {
  const bridge = await agentBridge(page)
  await emitApproval(page, bridge, 'req-window-1')

  // Blur the input so focus is not on an editable; the pane is the active
  // terminal pane (active===true), so the window keydown listener handles a/d.
  await page.locator(`${paneSel(bridge)} [data-bs-agent-input]`).evaluate((el) => (el as HTMLElement).blur())
  expect((await termMirror(page)).activeIsAgent).toBe(true)

  await page.keyboard.press('a')

  await expect(pending(page, bridge, 'req-window-1')).toHaveCount(0)
  await expectResolved(page, 'claude_approve', 'req-window-1')
})
