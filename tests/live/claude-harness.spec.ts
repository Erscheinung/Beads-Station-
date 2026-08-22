import { test, expect, boot, emit, invokeLog, spawnAgentPane, termMirror } from './helpers'

// Code-1bw: fake-claude harness spec.
// Verifies that streaming frames emitted on claude_event:<bridge> render
// in the chat scroll (FE side), and that the exit monitor (Code-key) fires
// claude_start on respawn when the status flips 'exited'.
// Uses the mock IPC layer — no real claude binary needed.

test('streaming frames render in legacy chat scroll', async ({ page }) => {
  await boot(page)
  const bridge = 'proj-a' // legacy chat bridge == project id

  // Emit an init frame (CLI-assigned session_id).
  await emit(page, `claude_event:${bridge}`, {
    type: 'system',
    subtype: 'init',
    session_id: 'fake-session-001',
    tools: [],
  })
  // Emit assistant turn 1.
  await emit(page, `claude_event:${bridge}`, {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'OK1 from fake-claude' }] },
  })
  // Wait for the text to appear in the DOM.
  await expect(page.locator('.bs-chat-scroll')).toContainText('OK1 from fake-claude')
})

test('second turn renders after result frame', async ({ page }) => {
  await boot(page)
  const bridge = 'proj-a'

  await emit(page, `claude_event:${bridge}`, {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'turn-A' }] },
  })
  await emit(page, `claude_event:${bridge}`, {
    type: 'result', subtype: 'success', session_id: 'fake-session-001',
    cost_usd: 0.0001,
    usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })
  await emit(page, `claude_event:${bridge}`, {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'turn-B' }] },
  })
  await expect(page.locator('.bs-chat-scroll')).toContainText('turn-A')
  await expect(page.locator('.bs-chat-scroll')).toContainText('turn-B')
})

test('exited status triggers respawn (auto-respawn invoke fired)', async ({ page }) => {
  await boot(page)
  const bridge = 'proj-a'

  // Simulate child exit: emit claude_status exited.
  await emit(page, `claude_status:${bridge}`, 'exited')

  // The ClaudeChat exit handler should fire claude_start to respawn.
  // Give it a moment to process the event.
  await page.waitForTimeout(300)
  const log = await invokeLog(page)
  const respawn = log.find(e => e.cmd === 'claude_start' && (e.args as any)?.projectId === bridge)
  expect(respawn, 'claude_start should be called on exited status').toBeTruthy()
})

test('agent pane frames render in correct pane', async ({ page }) => {
  await boot(page)
  await spawnAgentPane(page)

  const mirror = await termMirror(page)
  const agentBridge = mirror.activeAgentBridgeId
  expect(agentBridge).toBeTruthy()

  await emit(page, `claude_event:${agentBridge}`, {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'agent-response-OK' }] },
  })
  const pane = page.locator(`[data-bs-agent-pane="${agentBridge}"] .bs-chat-scroll`)
  await expect(pane).toContainText('agent-response-OK')
})

test('stderr line renders and does not crash', async ({ page }) => {
  await boot(page)
  const bridge = 'proj-a'

  await emit(page, `claude_stderr:${bridge}`, 'Error: Session ID abc is already in use.')
  // Error appears in the chat scroll as a stderr frame.
  await expect(page.locator('.bs-chat-scroll')).toContainText('Session ID abc is already in use.')
})
