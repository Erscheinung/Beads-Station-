import { useSyncExternalStore } from 'react'
import {
  createRecipeExecutor,
  createRecipeRecorder,
  createRecipeStore,
  RecipeCommandRegistry,
  type JsonObject,
  type Recipe,
  type RecipeCommands as RecipeCommandsOf,
  type RecipeContextExpectation,
  type RecipeRecorder,
  type RecipeRuntimeContext,
  type RecipeStore,
  type RecipeTarget,
  type SemanticCommandDispatch,
} from './recipes'

export type WorkspaceSelectArgs = { workspaceId: string }
export type TerminalSplitArgs = { direction: 'right' | 'down' }
export type TerminalFocusArgs = { direction: 'left' | 'right' | 'up' | 'down' }
export type ViewShowArgs = { view: 'board' | 'explorer' | 'terminal-only' | 'both' }

/** The allowlisted semantic surface shared by the palette, shortcuts, and
 * recipe executor. Raw terminal input never enters this registry. */
export const RECIPE_REGISTRY = RecipeCommandRegistry.empty()
  .register<'workspace.select', WorkspaceSelectArgs>('workspace.select', {
    authorization: 'none',
    parseArgs: value => object(value) && typeof value.workspaceId === 'string' && Object.keys(value).length === 1
      ? { workspaceId: value.workspaceId }
      : null,
    recordArgs: args => ({ ...args }),
  })
  .register<'workspace.open', WorkspaceSelectArgs>('workspace.open', {
    authorization: 'none',
    parseArgs: value => object(value) && typeof value.workspaceId === 'string' && Object.keys(value).length === 1
      ? { workspaceId: value.workspaceId }
      : null,
    recordArgs: args => ({ ...args }),
  })
  .register<'terminal.split', TerminalSplitArgs>('terminal.split', {
    authorization: 'process-control',
    parseArgs: value => object(value) && (value.direction === 'right' || value.direction === 'down') && Object.keys(value).length === 1
      ? { direction: value.direction }
      : null,
    recordArgs: args => ({ ...args }),
  })
  .register<'terminal.focus', TerminalFocusArgs>('terminal.focus', {
    authorization: 'process-control',
    parseArgs: value => object(value) && ['left', 'right', 'up', 'down'].includes(String(value.direction)) && Object.keys(value).length === 1
      ? { direction: value.direction as TerminalFocusArgs['direction'] }
      : null,
    recordArgs: args => ({ ...args }),
  })
  .register<'view.show', ViewShowArgs>('view.show', {
    authorization: 'none',
    parseArgs: value => object(value) && ['board', 'explorer', 'terminal-only', 'both'].includes(String(value.view)) && Object.keys(value).length === 1
      ? { view: value.view as ViewShowArgs['view'] }
      : null,
    recordArgs: args => ({ ...args }),
  })

export type AppRecipeCommands = RecipeCommandsOf<typeof RECIPE_REGISTRY>
export type AppRecipe = Recipe<AppRecipeCommands>
export type AppSemanticCommand = SemanticCommandDispatch<AppRecipeCommands>

export const recipeStore: RecipeStore<AppRecipeCommands> = createRecipeStore({ registry: RECIPE_REGISTRY })

let runtimeContext: RecipeRuntimeContext = {
  workspaceId: null,
  terminalId: null,
  view: null,
  fullscreen: false,
}
let knownWorkspaceIds = new Set<string>()
const recorderListeners = new Set<() => void>()
let recorder: RecipeRecorder<AppRecipeCommands> | null = null
let recorderSnapshot: Readonly<{ status: 'idle'; stepCount: 0 } | { status: 'recording'; stepCount: number }> = { status: 'idle', stepCount: 0 }
let activeReplay: ReturnType<ReturnType<typeof createRecipeExecutor<AppRecipeCommands>>['start']> | null = null
let lastReplay: string | null = null

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function currentExpectedContext(commandId: string): RecipeContextExpectation {
  // Workspace selection is deliberately portable between workspaces. The
  // remaining commands must stay in the workspace where they were recorded.
  return commandId.startsWith('workspace.') || runtimeContext.workspaceId === null
    ? {}
    : { workspaceId: runtimeContext.workspaceId }
}

export function setRecipeRuntimeContext(context: RecipeRuntimeContext, workspaceIds: readonly string[] = []): void {
  runtimeContext = { ...context }
  knownWorkspaceIds = new Set(workspaceIds)
}

export function getRecipeRuntimeContext(): RecipeRuntimeContext {
  return { ...runtimeContext }
}

export function dispatchSemanticCommand<Id extends keyof AppRecipeCommands & string>(
  commandId: Id,
  args: AppRecipeCommands[Id],
  target: RecipeTarget,
  origin: 'manual' | 'recipe' = 'manual',
  expectedContext: RecipeContextExpectation = currentExpectedContext(commandId),
): void {
  const parsed = RECIPE_REGISTRY.parseArgs(commandId, args)
  if (!parsed) throw new Error(`Invalid arguments for semantic command ${commandId}.`)
  if (typeof window === 'undefined') return
  const detail: AppSemanticCommand = {
    kind: 'semantic-command',
    origin,
    commandId,
    args: parsed as AppRecipeCommands[Id],
    target,
    expectedContext,
    timeoutMs: 10_000,
  } as AppSemanticCommand
  window.dispatchEvent(new CustomEvent('bs:semantic-command', { detail }))
}

function recipeSource() {
  return {
    subscribe(listener: (event: AppSemanticCommand) => void): () => void {
      if (typeof window === 'undefined') return () => {}
      const handler = (event: Event) => {
        listener((event as CustomEvent<AppSemanticCommand>).detail)
        if (recorder) {
          recorderSnapshot = recorder.getState()
          recorderListeners.forEach(update => update())
        }
      }
      window.addEventListener('bs:semantic-command', handler)
      return () => window.removeEventListener('bs:semantic-command', handler)
    },
  }
}

function getRecorder(): RecipeRecorder<AppRecipeCommands> {
  if (!recorder) recorder = createRecipeRecorder({ registry: RECIPE_REGISTRY, source: recipeSource() })
  return recorder
}

function notifyRecorder(): void {
  recorderSnapshot = getRecorder().getState()
  recorderListeners.forEach(listener => listener())
}

export function useRecipeRecording(): Readonly<{ status: 'idle'; stepCount: 0 } | { status: 'recording'; stepCount: number }> {
  return useSyncExternalStore(
    listener => { recorderListeners.add(listener); return () => recorderListeners.delete(listener) },
    () => recorderSnapshot,
    () => ({ status: 'idle', stepCount: 0 }),
  )
}

export function startRecipeRecording(): { ok: true; value: void } | { ok: false; error: string } {
  const result = getRecorder().start()
  notifyRecorder()
  return result
}

export function stopRecipeRecording(details: { id: string; name: string; description?: string }) {
  const result = getRecorder().stop(details)
  notifyRecorder()
  return result
}

export function cancelRecipeRecording(): void {
  getRecorder().cancel()
  notifyRecorder()
}

export function createRecipeId(): string {
  try { return `recipe-${crypto.randomUUID()}` } catch { return `recipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
}

export function targetExists(target: RecipeTarget, context: RecipeRuntimeContext = runtimeContext): boolean {
  switch (target.kind) {
    case 'application': return true
    case 'active-workspace': return context.workspaceId !== null && knownWorkspaceIds.has(context.workspaceId)
    case 'workspace': return knownWorkspaceIds.has(target.workspaceId)
    case 'active-terminal': return context.workspaceId !== null && context.terminalId !== null
    case 'terminal': return knownWorkspaceIds.has(target.workspaceId) && target.workspaceId === context.workspaceId
    // A view target is the destination of `view.show`; it need not already be
    // active. The expected workspace/context check still protects replay.
    case 'view': return true
  }
}

export function reviewWorkspaceFixture(workspaceId: string): AppRecipe {
  const now = Date.now()
  return {
    version: 1,
    id: 'review-workspace',
    name: 'Review workspace',
    description: 'Select a workspace, split right, focus right, and show the board.',
    binding: null,
    createdAt: now,
    updatedAt: now,
    steps: [
      {
        id: 'select-workspace', kind: 'command', commandId: 'workspace.select', args: { workspaceId },
        target: { kind: 'workspace', workspaceId }, expectedContext: {}, onMissingTarget: 'fail', onContextMismatch: 'fail', timeoutMs: 10_000,
      },
      {
        id: 'split-right', kind: 'command', commandId: 'terminal.split', args: { direction: 'right' },
        target: { kind: 'active-terminal' }, expectedContext: { workspaceId }, onMissingTarget: 'fail', onContextMismatch: 'fail', timeoutMs: 10_000,
      },
      {
        id: 'focus-right', kind: 'command', commandId: 'terminal.focus', args: { direction: 'right' },
        target: { kind: 'active-terminal' }, expectedContext: { workspaceId }, onMissingTarget: 'fail', onContextMismatch: 'fail', timeoutMs: 10_000,
      },
      {
        id: 'show-board', kind: 'command', commandId: 'view.show', args: { view: 'board' },
        target: { kind: 'view', view: 'board' }, expectedContext: { workspaceId }, onMissingTarget: 'fail', onContextMismatch: 'fail', timeoutMs: 10_000,
      },
    ],
  }
}

function authorizeRecipeStep(policy: string, summary?: string): boolean {
  if (policy !== 'terminal-command') return true
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return false
  return window.confirm(`Review advanced terminal command before running.\n\n${summary ?? 'Terminal command'}`)
}

export function startRecipeReplay(recipeId: string) {
  activeReplay?.cancel('A newer recipe replay started.')
  const executor = createRecipeExecutor<AppRecipeCommands>({
    registry: RECIPE_REGISTRY,
    getRecipe: id => recipeStore.getSnapshot().recipes.find(recipe => recipe.id === id),
    getContext: getRecipeRuntimeContext,
    targetExists,
    authorize: request => authorizeRecipeStep(request.policy, request.reviewSummary),
    dispatch: (commandId, args, target) => dispatchSemanticCommand(commandId, args, target, 'recipe'),
    dispatchTerminalCommand: step => {
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('bs:recipe-terminal-command', { detail: step }))
    },
  })
  const handle = executor.start(recipeId)
  activeReplay = handle
  void handle.result.then(result => {
    if (activeReplay === handle) activeReplay = null
    lastReplay = result.status === 'completed' ? `Recipe completed (${result.stepsCompleted} steps).` : result.error.message
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('recipe:replay-status', { detail: { result } }))
  })
  return handle
}

export function cancelRecipeReplay(): void {
  activeReplay?.cancel()
}

export function getLastRecipeReplayStatus(): string | null {
  return lastReplay
}

export function useRecipeStoreSnapshot(): ReturnType<typeof recipeStore.getSnapshot> {
  return useSyncExternalStore(recipeStore.subscribe, recipeStore.getSnapshot, recipeStore.getSnapshot)
}

// Recipe shortcuts are routed by the existing command keyboard listener. This
// listener only handles the semantic command event; it never observes keys.
if (typeof window !== 'undefined') {
  window.addEventListener('recipe:run-binding', event => {
    const recipeId = (event as CustomEvent<{ recipeId?: unknown }>).detail?.recipeId
    if (typeof recipeId === 'string') startRecipeReplay(recipeId)
  })
}
