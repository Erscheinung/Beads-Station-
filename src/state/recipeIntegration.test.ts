import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cancelRecipeRecording,
  dispatchSemanticCommand,
  getRecipeRuntimeContext,
  RECIPE_REGISTRY,
  reviewWorkspaceFixture,
  startRecipeRecording,
  stopRecipeRecording,
  targetExists,
} from './recipeIntegration'
import { clearRecipeBinding, dispatchCommand, matchedCommand, setRecipeBinding } from './commands'

describe('recipe application integration', () => {
  beforeEach(() => {
    cancelRecipeRecording()
    window.localStorage.clear()
  })

  afterEach(() => cancelRecipeRecording())

  afterEach(() => clearRecipeBinding('recorded-recipe'))

  it('records only allowlisted manual semantic commands with typed arguments', () => {
    expect(startRecipeRecording().ok).toBe(true)
    dispatchSemanticCommand('workspace.select', { workspaceId: 'workspace-a' }, { kind: 'workspace', workspaceId: 'workspace-a' })
    dispatchSemanticCommand('terminal.split', { direction: 'right' }, { kind: 'active-terminal' })
    dispatchSemanticCommand('workspace.select', { workspaceId: 'workspace-a' }, { kind: 'workspace', workspaceId: 'workspace-a' }, 'recipe')
    const result = stopRecipeRecording({ id: 'recorded-recipe', name: 'Recorded recipe' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.steps).toHaveLength(2)
    expect(result.value.steps.map(step => step.kind === 'command' ? step.commandId : step.kind)).toEqual(['workspace.select', 'terminal.split'])
    expect(result.value.steps[1]).toMatchObject({ args: { direction: 'right' }, target: { kind: 'active-terminal' } })
  })

  it('provides a deterministic review fixture and actionable target checks', () => {
    const fixture = reviewWorkspaceFixture('workspace-a')
    expect(RECIPE_REGISTRY.parseArgs('terminal.focus', { direction: 'right' })).toEqual({ direction: 'right' })
    expect(fixture.name).toBe('Review workspace')
    expect(fixture.steps.map(step => step.kind === 'command' ? step.commandId : step.kind)).toEqual([
      'workspace.select', 'terminal.split', 'terminal.focus', 'view.show',
    ])
    expect(targetExists({ kind: 'workspace', workspaceId: 'workspace-a' }, { ...getRecipeRuntimeContext(), workspaceId: 'workspace-a' })).toBe(false)
  })

  it('routes recipe shortcuts through the existing command matcher', () => {
    expect(setRecipeBinding('recorded-recipe', 'Recorded recipe', 'Mod+Shift+R')).toBeNull()
    expect(matchedCommand(new KeyboardEvent('keydown', { key: 'R', metaKey: true, shiftKey: true }))).toBe('recipe:recorded-recipe')
    const events: string[] = []
    const listener = (event: Event) => events.push(String((event as CustomEvent<{ recipeId?: string }>).detail?.recipeId))
    window.addEventListener('recipe:run-binding', listener)
    dispatchCommand('recipe:recorded-recipe')
    window.removeEventListener('recipe:run-binding', listener)
    expect(events).toEqual(['recorded-recipe'])
  })
})
