import { test, expect } from './helpers'
import { boot, spawnAgentPane, termMirror, emit } from './helpers'
import type { Page } from '@playwright/test'

// RV3-A (Code-d3p) live-verify: rich agent rendering.
// Emits real claude_event frames into a spawned agent pane and asserts the
// buildRenderItems -> RenderItems pipeline renders a single collapsible
// PairedToolCall (not two raw frames), a DiffView with +/- and a
// unified<->side-by-side toggle, and a recursive subagent chain.
//
// Frame wire shapes (renderItems.ts:19-24):
//   assistant   : { type:'assistant', parent_tool_use_id, message:{ content:[
//                    { type:'text', text } | { type:'tool_use', id, name, input } ] } }
//   tool_result : { type:'user', message:{ content:[
//                    { type:'tool_result', tool_use_id, content, is_error? } ] } }

async function agentBridge(page: Page): Promise<string> {
  const m = await termMirror(page)
  expect(m.activeAgentBridgeId).toBeTruthy()
  return m.activeAgentBridgeId
}

function assistantToolUse(id: string, name: string, input: unknown) {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id, name, input }] },
  }
}

function toolResult(toolUseId: string, content: string, isError = false) {
  return {
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
    },
  }
}

test.beforeEach(async ({ page }) => {
  await boot(page)
  await spawnAgentPane(page)
})

test('a tool_use + matching tool_result render as ONE collapsible ToolPair', async ({ page }) => {
  const bridge = await agentBridge(page)
  const ch = `claude_event:${bridge}`

  await emit(page, ch, assistantToolUse('tu-1', 'Bash', { command: 'ls -la' }))
  await emit(page, ch, toolResult('tu-1', 'total 8\ndrwxr-xr-x'))

  // One paired tool unit, not two loose frames.
  await expect(page.locator('.bs-tool').filter({ hasNot: page.locator('.bs-diff, .bs-task') })).toHaveCount(1)
  const head = page.locator('.bs-tool-head').first()
  await expect(head).toContainText('Bash')
  await expect(head).toContainText('ls -la')

  // Collapsed by default; clicking the header reveals the result body.
  await expect(head).toHaveAttribute('aria-expanded', 'false')
  await head.click()
  await expect(head).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('.bs-tool-result')).toContainText('total 8')
})

test('an Edit tool renders a DiffView with +/- and toggles unified<->side-by-side', async ({ page }) => {
  const bridge = await agentBridge(page)
  const ch = `claude_event:${bridge}`

  await emit(page, ch, assistantToolUse('tu-2', 'Edit', {
    file_path: '/tmp/x.ts',
    old_string: 'const a = 1\nconst b = 2\n',
    new_string: 'const a = 1\nconst b = 3\n',
  }))
  await emit(page, ch, toolResult('tu-2', 'ok'))

  const diff = page.locator('.bs-tool.bs-diff')
  await expect(diff).toHaveCount(1)
  // Diffs default open; line-count delta present.
  await expect(diff.locator('.bs-diff-delta-add')).toContainText('+')
  await expect(diff.locator('.bs-diff-delta-del')).toContainText('-')
  // Unified by default.
  await expect(diff.locator('.bs-diff-body')).toBeVisible()
  await expect(diff.locator('.bs-diff-split')).toHaveCount(0)
  // Toggle to side-by-side.
  await diff.locator('.bs-diff-toggle').click()
  await expect(diff.locator('.bs-diff-split')).toHaveCount(1)
  await expect(diff.locator('.bs-diff-col')).toHaveCount(2)
})

test('a Task tool_use gathers subagent frames into a recursive collapsible chain', async ({ page }) => {
  const bridge = await agentBridge(page)
  const ch = `claude_event:${bridge}`

  // Parent Task frame + a child frame tagged with parent_tool_use_id.
  await emit(page, ch, assistantToolUse('task-1', 'Task', { description: 'explore repo' }))
  await emit(page, ch, {
    type: 'assistant',
    parent_tool_use_id: 'task-1',
    message: { content: [{ type: 'text', text: 'child agent step' }] },
  })
  await emit(page, ch, toolResult('task-1', 'subagent done'))

  const task = page.locator('.bs-tool.bs-task')
  await expect(task).toHaveCount(1)
  await expect(task.locator('.bs-tool-head')).toContainText('Task')
  // Collapsed by default; expand to reveal the nested child.
  await task.locator('.bs-tool-head').click()
  await expect(task.locator('.bs-task-body')).toContainText('child agent step')
})
