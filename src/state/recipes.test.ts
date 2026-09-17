import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RECIPE_SCHEMA_VERSION,
  RecipeCommandRegistry,
  createRecipeExecutor,
  createRecipeRecorder,
  createRecipeStore,
  parseRecipeDocument,
  type JsonObject,
  type Recipe,
  type RecipeCommands,
  type RecipeExecutionDependencies,
  type RecipeStep,
  type RecipeStorage,
  type SemanticCommandDispatch,
} from './recipes'

type WorkspaceArgs = { workspaceId: string }
type SplitArgs = { direction: 'right' | 'down' }
type SecretArgs = { password: string }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const registry = RecipeCommandRegistry.empty()
  .register<"workspace.select", WorkspaceArgs>('workspace.select', {
    authorization: 'none',
    parseArgs(value) {
      return object(value) && typeof value.workspaceId === 'string' && Object.keys(value).length === 1
        ? { workspaceId: value.workspaceId }
        : null
    },
    recordArgs: args => ({ ...args }),
  })
  .register<"terminal.split", SplitArgs>('terminal.split', {
    authorization: 'process-control',
    parseArgs(value) {
      return object(value) && (value.direction === 'right' || value.direction === 'down') && Object.keys(value).length === 1
        ? { direction: value.direction }
        : null
    },
    recordArgs: args => ({ ...args }),
  })
  .register<"account.sign-in", SecretArgs>('account.sign-in', {
    authorization: 'confirm',
    parseArgs(value) {
      return object(value) && typeof value.password === 'string' && Object.keys(value).length === 1
        ? { password: value.password }
        : null
    },
  })

type Commands = RecipeCommands<typeof registry>

function commandStep(
  id: string,
  commandId: 'workspace.select' | 'terminal.split' = 'workspace.select',
): RecipeStep<Commands> {
  const command = commandId === 'workspace.select'
    ? { commandId, args: { workspaceId: 'workspace-a' } }
    : { commandId, args: { direction: 'right' as const } }
  return {
    id,
    kind: 'command',
    ...command,
    target: { kind: 'application' },
    expectedContext: {},
    onMissingTarget: 'fail',
    onContextMismatch: 'fail',
    timeoutMs: 1_000,
  } as RecipeStep<Commands>
}

function recipe(id = 'recipe-a', steps: RecipeStep<Commands>[] = [commandStep('step-a')]): Recipe<Commands> {
  return {
    version: RECIPE_SCHEMA_VERSION,
    id,
    name: `Recipe ${id}`,
    steps,
    createdAt: 100,
    updatedAt: 100,
  }
}

class MemoryStorage implements RecipeStorage {
  readonly values = new Map<string, string>()
  writes = 0
  failWrites = false

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('disk full')
    this.writes += 1
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

function executionDependencies(
  recipes: Recipe<Commands>[],
  overrides: Partial<RecipeExecutionDependencies<Commands>> = {},
): RecipeExecutionDependencies<Commands> {
  return {
    registry,
    getRecipe: id => recipes.find(item => item.id === id),
    getContext: () => ({ workspaceId: 'workspace-a', terminalId: 'terminal-a', view: 'terminal', fullscreen: false }),
    targetExists: () => true,
    authorize: () => true,
    dispatch: () => undefined,
    dispatchTerminalCommand: () => undefined,
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('recipe schema and persistence', () => {
  it('accepts only allowlisted commands and schema-valid JSON-safe arguments', () => {
    const valid = parseRecipeDocument({ schemaVersion: 1, recipes: [recipe()] }, registry)
    expect(valid.ok).toBe(true)

    const unknown = recipe('unknown') as unknown as { steps: Array<Record<string, unknown>> }
    unknown.steps[0] = { ...unknown.steps[0], commandId: 'terminal.raw-input' }
    expect(parseRecipeDocument({ schemaVersion: 1, recipes: [unknown] }, registry)).toEqual(expect.objectContaining({ ok: false }))

    const badArgs = recipe('bad-args') as unknown as { steps: Array<Record<string, unknown>> }
    badArgs.steps[0] = { ...badArgs.steps[0], args: { workspaceId: 'workspace-a', password: 'leak' } }
    const result = parseRecipeDocument({ schemaVersion: 1, recipes: [badArgs] }, registry)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Arguments')
  })

  it('keeps migration boundaries explicit and revalidates migrated data', () => {
    const legacy = { schemaVersion: 0, items: [recipe()] }
    const migrated = parseRecipeDocument(legacy, registry, [{
      from: 0,
      to: 1,
      migrate(value) {
        return { schemaVersion: 1, recipes: object(value) && Array.isArray(value.items) ? value.items : [] }
      },
    }])
    expect(migrated.ok).toBe(true)
    expect(parseRecipeDocument(legacy, registry)).toEqual(expect.objectContaining({ ok: false }))
    expect(parseRecipeDocument({ schemaVersion: 2, recipes: [] }, registry)).toEqual(expect.objectContaining({ ok: false }))
    expect(parseRecipeDocument(legacy, registry, [{ from: 0, to: 1, migrate: () => ({ schemaVersion: 1, recipes: [{ unsafe: true }] }) }])).toEqual(expect.objectContaining({ ok: false }))
  })

  it('persists rename, duplicate, delete, reorder, binding, and bounded undo edits', () => {
    const storage = new MemoryStorage()
    let nextId = 0
    const store = createRecipeStore({ registry, storage, maxUndo: 2, now: () => 200, idFactory: () => `copy-${++nextId}` })
    expect(store.save(recipe('original', [commandStep('first'), commandStep('second', 'terminal.split')])).ok).toBe(true)
    expect(store.rename('original', 'Review workspace').ok).toBe(true)
    expect(store.setBinding('original', 'Mod+Shift+9').ok).toBe(true)
    expect(store.reorderStep('original', 0, 1).ok).toBe(true)
    expect(store.getSnapshot().recipes[0].steps.map(step => step.id)).toEqual(['second', 'first'])

    expect(store.duplicate('original').ok).toBe(true)
    const copy = store.getSnapshot().recipes.find(item => item.id === 'copy-1')
    expect(copy).toMatchObject({ name: 'Review workspace copy', binding: null })
    expect(store.delete('copy-1').ok).toBe(true)
    expect(store.undo().ok).toBe(true)
    expect(store.getSnapshot().recipes.some(item => item.id === 'copy-1')).toBe(true)
    expect(store.undo().ok).toBe(true)
    expect(store.getSnapshot().recipes.some(item => item.id === 'copy-1')).toBe(false)
    expect(store.undo()).toEqual(expect.objectContaining({ ok: false }))
    expect(storage.writes).toBeGreaterThan(0)
    const reloaded = createRecipeStore({ registry, storage })
    expect(reloaded.getSnapshot().recipes[0]).toMatchObject({ name: 'Review workspace', binding: 'Mod+Shift+9' })
    expect(reloaded.getSnapshot().recipes[0].steps.map(step => step.id)).toEqual(['second', 'first'])
  })

  it('removes a selected step through the persisted edit boundary', () => {
    const store = createRecipeStore({ registry, storage: new MemoryStorage() })
    expect(store.save(recipe('remove-step', [commandStep('first'), commandStep('second', 'terminal.split')])).ok).toBe(true)
    expect(store.removeStep('remove-step', 0).ok).toBe(true)
    expect(store.getSnapshot().recipes[0].steps.map(step => step.id)).toEqual(['second'])
    expect(store.undo().ok).toBe(true)
    expect(store.getSnapshot().recipes[0].steps.map(step => step.id)).toEqual(['first', 'second'])
  })

  it('exports/imports validated documents and rejects collisions unless replace is explicit', () => {
    const source = createRecipeStore({ registry, storage: new MemoryStorage() })
    expect(source.save(recipe()).ok).toBe(true)
    const exported = source.exportJson()
    expect(exported.ok).toBe(true)
    if (!exported.ok) throw new Error(exported.error)

    const target = createRecipeStore({ registry, storage: new MemoryStorage() })
    expect(target.importJson(exported.value).ok).toBe(true)
    expect(target.importJson(exported.value)).toEqual(expect.objectContaining({ ok: false }))
    expect(target.importJson(exported.value, 'replace').ok).toBe(true)
    expect(target.getSnapshot().recipes).toHaveLength(1)
    expect(target.importJson('{"schemaVersion":1,"recipes":[{"unsafe":true}]}')).toEqual(expect.objectContaining({ ok: false }))
  })

  it('does not overwrite corrupt persistence or mutate memory after a failed write', () => {
    const storage = new MemoryStorage()
    storage.values.set('beads-station.recipes.v1', '{broken')
    const store = createRecipeStore({ registry, storage })
    expect(store.getLoadError()).toContain('valid JSON')
    expect(store.save(recipe())).toEqual(expect.objectContaining({ ok: false }))
    expect(storage.values.get('beads-station.recipes.v1')).toBe('{broken')

    const recovery = JSON.stringify({ schemaVersion: 1, recipes: [recipe()] })
    expect(store.importJson(recovery, 'replace').ok).toBe(true)
    storage.failWrites = true
    expect(store.rename('recipe-a', 'Will not stick')).toEqual(expect.objectContaining({ ok: false }))
    expect(store.getSnapshot().recipes[0].name).toBe('Recipe recipe-a')
  })
})

describe('recipe recorder', () => {
  it('subscribes only while active and records only safe manual semantic dispatches', () => {
    let listener: ((event: SemanticCommandDispatch<Commands>) => void) | undefined
    let subscriptions = 0
    let unsubscriptions = 0
    const recorder = createRecipeRecorder({
      registry,
      source: {
        subscribe(next) {
          subscriptions += 1
          listener = next
          return () => { unsubscriptions += 1; listener = undefined }
        },
      },
      stepIdFactory: () => 'recorded-step',
      now: () => 500,
    })

    expect(recorder.getState()).toEqual({ status: 'idle', stepCount: 0 })
    expect(subscriptions).toBe(0)
    expect(recorder.start().ok).toBe(true)
    expect(subscriptions).toBe(1)

    listener?.({
      kind: 'semantic-command', origin: 'manual', commandId: 'workspace.select',
      args: { workspaceId: 'workspace-a' }, target: { kind: 'application' }, expectedContext: {},
    })
    listener?.({
      kind: 'semantic-command', origin: 'recipe', commandId: 'terminal.split',
      args: { direction: 'right' }, target: { kind: 'application' }, expectedContext: {},
    })
    listener?.({
      kind: 'semantic-command', origin: 'manual', commandId: 'account.sign-in',
      args: { password: 'not-recorded' }, target: { kind: 'application' }, expectedContext: {},
    })
    listener?.({ kind: 'terminal-input', value: 'raw password' } as unknown as SemanticCommandDispatch<Commands>)

    expect(recorder.getState()).toEqual({ status: 'recording', stepCount: 1 })
    const stopped = recorder.stop({ id: 'recorded', name: 'Recorded actions' })
    expect(stopped.ok).toBe(true)
    if (stopped.ok) {
      expect(stopped.value.steps).toHaveLength(1)
      expect(stopped.value.steps[0]).toMatchObject({ commandId: 'workspace.select', args: { workspaceId: 'workspace-a' } })
      expect(JSON.stringify(stopped.value)).not.toContain('password')
    }
    expect(unsubscriptions).toBe(1)
    expect(recorder.getState()).toEqual({ status: 'idle', stepCount: 0 })
  })

  it('unsubscribes and discards steps on cancel', () => {
    let subscribed = false
    const recorder = createRecipeRecorder({
      registry,
      source: { subscribe: () => { subscribed = true; return () => { subscribed = false } } },
    })
    recorder.start()
    expect(subscribed).toBe(true)
    recorder.cancel()
    expect(subscribed).toBe(false)
    expect(recorder.stop({ id: 'none', name: 'None' })).toEqual(expect.objectContaining({ ok: false }))
  })
})

describe('recipe replay', () => {
  it('uses injected waits, target/context checks, authorization, and semantic dispatch', async () => {
    let ready = false
    const dispatch = vi.fn()
    const authorize = vi.fn(() => true)
    const waitStep = {
      ...commandStep('wait-step', 'terminal.split'),
      target: { kind: 'workspace', workspaceId: 'workspace-a' } as const,
      expectedContext: { view: 'board' as const },
      waitBefore: [
        { kind: 'context', expectedContext: { view: 'board' as const }, pollIntervalMs: 10 },
        { kind: 'target', target: { kind: 'workspace', workspaceId: 'workspace-a' } as const, pollIntervalMs: 10 },
      ],
    } as RecipeStep<Commands>
    const current = recipe('wait-recipe', [waitStep])
    const executor = createRecipeExecutor(executionDependencies([current], {
      getContext: () => ({ workspaceId: 'workspace-a', terminalId: null, view: ready ? 'board' : 'terminal', fullscreen: false }),
      targetExists: target => target.kind === 'workspace' ? ready : true,
      authorize,
      dispatch,
      pause: async () => { ready = true },
    }))

    const result = await executor.start('wait-recipe').result
    expect(result).toEqual({ status: 'completed', recipeId: 'wait-recipe', stepsCompleted: 1 })
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ commandId: 'terminal.split', policy: 'process-control', advanced: false }), expect.any(AbortSignal))
    expect(dispatch).toHaveBeenCalledWith('terminal.split', { direction: 'right' }, { kind: 'workspace', workspaceId: 'workspace-a' }, expect.any(AbortSignal))
  })

  it('fails closed when the expected context or target is missing', async () => {
    const dispatch = vi.fn()
    const contextual = recipe('contextual', [{ ...commandStep('context'), expectedContext: { view: 'board' } } as RecipeStep<Commands>])
    const contextResult = await createRecipeExecutor(executionDependencies([contextual], { dispatch })).start('contextual').result
    expect(contextResult).toMatchObject({ status: 'failed', error: { code: 'context-mismatch', stepId: 'context' } })

    const targetResult = await createRecipeExecutor(executionDependencies([recipe()], { targetExists: () => false, dispatch })).start('recipe-a').result
    expect(targetResult).toMatchObject({ status: 'failed', error: { code: 'missing-target', stepId: 'step-a' } })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('cancels active dispatch and reports the last completed step', async () => {
    const dispatch = vi.fn((_id: string, _args: JsonObject, _target: unknown, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    const handle = createRecipeExecutor(executionDependencies([recipe()], { dispatch })).start('recipe-a')
    handle.cancel('Stopped by user.')
    const result = await handle.result
    expect(result).toMatchObject({ status: 'cancelled', stepsCompleted: 0, error: { code: 'cancelled', message: 'Stopped by user.' } })
  })

  it('times out a step even when an injected dispatcher ignores cancellation', async () => {
    vi.useFakeTimers()
    const timed = recipe('timed', [{ ...commandStep('slow'), timeoutMs: 50 } as RecipeStep<Commands>])
    const handle = createRecipeExecutor(executionDependencies([timed], { dispatch: () => new Promise<void>(() => undefined) })).start('timed')
    await vi.advanceTimersByTimeAsync(51)
    expect(await handle.result).toMatchObject({ status: 'failed', error: { code: 'timed-out', stepId: 'slow' } })
  })

  it('bounds recursive recipe calls and total executed steps', async () => {
    const nestedBase = {
      id: 'nested', kind: 'recipe', recipeId: 'recipe-b', target: { kind: 'application' }, expectedContext: {},
      onMissingTarget: 'fail', onContextMismatch: 'fail', timeoutMs: 1_000,
    } as const
    const recipeA = recipe('recipe-a', [nestedBase])
    const recipeB = recipe('recipe-b', [{ ...nestedBase, id: 'back', recipeId: 'recipe-a' }])
    const recursive = await createRecipeExecutor(executionDependencies([recipeA, recipeB])).start('recipe-a').result
    expect(recursive).toMatchObject({ status: 'failed', error: { code: 'recursion-limit' } })

    const twoSteps = recipe('two', [commandStep('one'), commandStep('two')])
    const bounded = await createRecipeExecutor(executionDependencies([twoSteps]), { maxTotalSteps: 1 }).start('two').result
    expect(bounded).toMatchObject({ status: 'failed', stepsCompleted: 1, error: { code: 'step-limit', stepId: 'two' } })
  })

  it('keeps advanced terminal commands separate and requires every-run authorization', async () => {
    const terminalDispatch = vi.fn()
    const advancedStep: RecipeStep<Commands> = {
      id: 'advanced',
      kind: 'terminal-command',
      command: 'printf safe-demo',
      target: { kind: 'active-terminal' },
      expectedContext: { view: 'terminal' },
      onMissingTarget: 'fail',
      onContextMismatch: 'fail',
      timeoutMs: 1_000,
      review: { mode: 'every-run', summary: 'Print a fixed demo marker' },
    }
    const advanced = recipe('advanced-recipe', [advancedStep])
    const authorize = vi.fn(() => false)
    const result = await createRecipeExecutor(executionDependencies([advanced], {
      authorize,
      dispatchTerminalCommand: terminalDispatch,
    })).start('advanced-recipe').result

    expect(result).toMatchObject({ status: 'failed', error: { code: 'unauthorized', stepId: 'advanced' } })
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 'terminal-command', policy: 'terminal-command', advanced: true,
      reviewSummary: 'Print a fixed demo marker',
    }), expect.any(AbortSignal))
    expect(terminalDispatch).not.toHaveBeenCalled()
    expect(() => RecipeCommandRegistry.empty().register('terminal-command', {
      authorization: 'terminal-command', parseArgs: () => ({}),
    })).toThrow('terminal-command recipe step')
  })
})
