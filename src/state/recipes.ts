import { persistDurableUserConfigKey } from '../lib/durableUserConfig'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export type JsonObject = { [key: string]: JsonValue }

export const RECIPE_SCHEMA_VERSION = 1 as const
export const RECIPE_STORAGE_KEY = 'beads-station.recipes.v1'

const MAX_RECIPES = 100
const MAX_STEPS = 100
const MAX_TOTAL_REPLAY_STEPS = 250
const MAX_RECURSION_DEPTH = 4
const MAX_STEP_TIMEOUT_MS = 60_000
const MAX_WAIT_MS = 30_000
const MAX_WAITS_PER_STEP = 8
const MAX_JSON_DEPTH = 12
const MAX_JSON_ENTRIES = 1_000

export type RecipeAuthorizationPolicy =
  | 'none'
  | 'confirm'
  | 'workspace-write'
  | 'process-control'
  | 'terminal-command'

interface RuntimeCommandSpec {
  authorization: RecipeAuthorizationPolicy
  parseArgs(value: unknown): JsonObject | null
  recordArgs?: (value: unknown) => JsonObject | null
}

export interface RecipeCommandSpec<Args extends JsonObject> {
  authorization: RecipeAuthorizationPolicy
  parseArgs(value: unknown): Args | null
  /**
   * An explicit safe projection is required before a command can be recorded.
   * Omit it for commands whose arguments may contain clipboard data, secrets,
   * passwords, terminal input, or another non-recordable value.
   */
  recordArgs?(args: Args): Args | null
}

export class RecipeCommandRegistry<Commands extends Record<string, JsonObject> = Record<never, never>> {
  private constructor(private readonly specs: ReadonlyMap<string, RuntimeCommandSpec>) {}

  static empty(): RecipeCommandRegistry {
    return new RecipeCommandRegistry(new Map())
  }

  register<Id extends string, Args extends JsonObject>(
    commandId: Id,
    spec: RecipeCommandSpec<Args>,
  ): RecipeCommandRegistry<Commands & Record<Id, Args>> {
    if (!validIdentifier(commandId)) throw new Error(`Invalid recipe command ID: ${commandId}`)
    if (commandId === 'terminal-command' || spec.authorization === 'terminal-command') {
      throw new Error('Advanced terminal commands must use a terminal-command recipe step.')
    }
    if (this.specs.has(commandId)) throw new Error(`Duplicate recipe command ID: ${commandId}`)
    const next = new Map(this.specs)
    next.set(commandId, {
      authorization: spec.authorization,
      parseArgs: value => {
        const parsed = spec.parseArgs(value)
        return parsed && validJsonObject(parsed) ? cloneJsonObject(parsed) : null
      },
      recordArgs: spec.recordArgs
        ? value => {
            const parsed = spec.parseArgs(value)
            if (!parsed) return null
            const safe = spec.recordArgs?.(parsed)
            return safe && validJsonObject(safe) ? cloneJsonObject(safe) : null
          }
        : undefined,
    })
    return new RecipeCommandRegistry(next)
  }

  has(commandId: string): commandId is keyof Commands & string {
    return this.specs.has(commandId)
  }

  parseArgs(commandId: string, value: unknown): JsonObject | null {
    return this.specs.get(commandId)?.parseArgs(value) ?? null
  }

  recordArgs(commandId: string, value: unknown): JsonObject | null {
    return this.specs.get(commandId)?.recordArgs?.(value) ?? null
  }

  authorizationFor(commandId: string): RecipeAuthorizationPolicy | null {
    return this.specs.get(commandId)?.authorization ?? null
  }
}

export type RecipeCommands<Registry> = Registry extends RecipeCommandRegistry<infer Commands> ? Commands : never

export type RecipeView = 'terminal' | 'board' | 'designer' | 'files' | 'settings'

export type RecipeTarget =
  | { kind: 'application' }
  | { kind: 'active-workspace' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'active-terminal' }
  | { kind: 'terminal'; workspaceId: string; terminalId: string }
  | { kind: 'view'; view: RecipeView }

export interface RecipeContextExpectation {
  workspaceId?: string
  terminalId?: string
  view?: RecipeView
  fullscreen?: boolean
}

export interface RecipeRuntimeContext {
  workspaceId: string | null
  terminalId: string | null
  view: RecipeView | null
  fullscreen: boolean
}

export type RecipeWaitCondition =
  | { kind: 'delay'; milliseconds: number }
  | { kind: 'target'; target: RecipeTarget; pollIntervalMs: number }
  | { kind: 'context'; expectedContext: RecipeContextExpectation; pollIntervalMs: number }

interface RecipeStepBase {
  id: string
  target: RecipeTarget
  expectedContext: RecipeContextExpectation
  onMissingTarget: 'fail'
  onContextMismatch: 'fail'
  timeoutMs: number
  waitBefore?: RecipeWaitCondition[]
  waitAfter?: RecipeWaitCondition[]
}

export type CommandRecipeStep<Commands extends Record<string, JsonObject> = Record<string, JsonObject>> = {
  [Id in keyof Commands & string]: RecipeStepBase & {
    kind: 'command'
    commandId: Id
    args: Commands[Id]
  }
}[keyof Commands & string]

export interface TerminalCommandRecipeStep extends RecipeStepBase {
  kind: 'terminal-command'
  command: string
  workingDirectory?: string
  review: {
    mode: 'every-run'
    summary: string
  }
}

export interface NestedRecipeStep extends RecipeStepBase {
  kind: 'recipe'
  recipeId: string
}

export type RecipeStep<Commands extends Record<string, JsonObject> = Record<string, JsonObject>> =
  | CommandRecipeStep<Commands>
  | TerminalCommandRecipeStep
  | NestedRecipeStep

export interface Recipe<Commands extends Record<string, JsonObject> = Record<string, JsonObject>> {
  version: typeof RECIPE_SCHEMA_VERSION
  id: string
  name: string
  description?: string
  binding?: string | null
  steps: RecipeStep<Commands>[]
  createdAt: number
  updatedAt: number
}

export interface RecipeDocument<Commands extends Record<string, JsonObject> = Record<string, JsonObject>> {
  schemaVersion: typeof RECIPE_SCHEMA_VERSION
  recipes: Recipe<Commands>[]
}

export interface RecipeMigration {
  from: number
  to: number
  migrate(document: unknown): unknown
}

export type RecipeParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

export function parseRecipeDocument<Commands extends Record<string, JsonObject>>(
  input: string | unknown,
  registry: RecipeCommandRegistry<Commands>,
  migrations: readonly RecipeMigration[] = [],
): RecipeParseResult<RecipeDocument<Commands>> {
  let raw: unknown
  try {
    raw = typeof input === 'string' ? JSON.parse(input) : input
  } catch {
    return failure('Recipe document is not valid JSON.')
  }

  const migrated = migrateDocument(raw, migrations)
  if (!migrated.ok) return migrated
  if (!isRecord(migrated.value) || !onlyKeys(migrated.value, ['schemaVersion', 'recipes'])) {
    return failure('Recipe document must contain only schemaVersion and recipes.')
  }
  if (migrated.value.schemaVersion !== RECIPE_SCHEMA_VERSION) {
    return failure(`Unsupported recipe schema version: ${String(migrated.value.schemaVersion)}.`)
  }
  if (!Array.isArray(migrated.value.recipes) || migrated.value.recipes.length > MAX_RECIPES) {
    return failure(`Recipe document must contain at most ${MAX_RECIPES} recipes.`)
  }

  const recipes: Recipe<Commands>[] = []
  const ids = new Set<string>()
  for (let index = 0; index < migrated.value.recipes.length; index += 1) {
    const parsed = parseRecipe(migrated.value.recipes[index], registry)
    if (!parsed.ok) return failure(`Recipe ${index + 1}: ${parsed.error}`)
    if (ids.has(parsed.value.id)) return failure(`Duplicate recipe ID: ${parsed.value.id}.`)
    ids.add(parsed.value.id)
    recipes.push(parsed.value)
  }
  return success({ schemaVersion: RECIPE_SCHEMA_VERSION, recipes })
}

export function parseRecipe<Commands extends Record<string, JsonObject>>(
  value: unknown,
  registry: RecipeCommandRegistry<Commands>,
): RecipeParseResult<Recipe<Commands>> {
  if (!isRecord(value) || !onlyKeys(value, ['version', 'id', 'name', 'description', 'binding', 'steps', 'createdAt', 'updatedAt'])) {
    return failure('Recipe has unknown or missing fields.')
  }
  if (value.version !== RECIPE_SCHEMA_VERSION) return failure(`Unsupported recipe version: ${String(value.version)}.`)
  if (!validIdentifier(value.id)) return failure('Recipe ID is invalid.')
  if (!boundedString(value.name, 1, 120) || value.name.trim() !== value.name) return failure('Recipe name is invalid.')
  if (value.description !== undefined && !boundedString(value.description, 0, 2_000)) return failure('Recipe description is invalid.')
  if (value.binding !== undefined && value.binding !== null && !boundedString(value.binding, 1, 64)) return failure('Recipe binding is invalid.')
  if (!validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt) || value.updatedAt < value.createdAt) {
    return failure('Recipe timestamps are invalid.')
  }
  if (!Array.isArray(value.steps) || value.steps.length > MAX_STEPS) {
    return failure(`Recipe must contain at most ${MAX_STEPS} steps.`)
  }

  const stepIds = new Set<string>()
  const steps: RecipeStep<Commands>[] = []
  for (let index = 0; index < value.steps.length; index += 1) {
    const parsed = parseStep(value.steps[index], registry)
    if (!parsed.ok) return failure(`Step ${index + 1}: ${parsed.error}`)
    if (stepIds.has(parsed.value.id)) return failure(`Duplicate step ID: ${parsed.value.id}.`)
    stepIds.add(parsed.value.id)
    steps.push(parsed.value)
  }

  return success({
    version: RECIPE_SCHEMA_VERSION,
    id: value.id,
    name: value.name,
    ...(value.description !== undefined ? { description: value.description } : {}),
    ...(value.binding !== undefined ? { binding: value.binding } : {}),
    steps,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  })
}

function parseStep<Commands extends Record<string, JsonObject>>(
  value: unknown,
  registry: RecipeCommandRegistry<Commands>,
): RecipeParseResult<RecipeStep<Commands>> {
  if (!isRecord(value) || typeof value.kind !== 'string') return failure('Recipe step is invalid.')
  const base = parseStepBase(value)
  if (!base.ok) return base

  if (value.kind === 'command') {
    if (!onlyKeys(value, [...BASE_STEP_KEYS, 'kind', 'commandId', 'args'])) return failure('Command step has unknown fields.')
    if (typeof value.commandId !== 'string' || !registry.has(value.commandId)) return failure(`Command is not allowlisted: ${String(value.commandId)}.`)
    const args = registry.parseArgs(value.commandId, value.args)
    if (!args) return failure(`Arguments for ${value.commandId} are invalid.`)
    return success({ ...base.value, kind: 'command', commandId: value.commandId, args } as CommandRecipeStep<Commands>)
  }

  if (value.kind === 'terminal-command') {
    if (!onlyKeys(value, [...BASE_STEP_KEYS, 'kind', 'command', 'workingDirectory', 'review'])) return failure('Terminal command step has unknown fields.')
    if (!boundedString(value.command, 1, 4_096)) return failure('Terminal command is invalid.')
    if (value.workingDirectory !== undefined && !boundedString(value.workingDirectory, 1, 4_096)) return failure('Working directory is invalid.')
    if (!isRecord(value.review) || !onlyKeys(value.review, ['mode', 'summary']) || value.review.mode !== 'every-run' || !boundedString(value.review.summary, 1, 240)) {
      return failure('Terminal commands require an every-run review summary.')
    }
    if (base.value.target.kind !== 'active-terminal' && base.value.target.kind !== 'terminal') {
      return failure('Terminal commands require an explicit terminal target.')
    }
    return success({
      ...base.value,
      kind: 'terminal-command',
      command: value.command,
      ...(value.workingDirectory !== undefined ? { workingDirectory: value.workingDirectory } : {}),
      review: { mode: 'every-run', summary: value.review.summary },
    })
  }

  if (value.kind === 'recipe') {
    if (!onlyKeys(value, [...BASE_STEP_KEYS, 'kind', 'recipeId'])) return failure('Nested recipe step has unknown fields.')
    if (!validIdentifier(value.recipeId)) return failure('Nested recipe ID is invalid.')
    return success({ ...base.value, kind: 'recipe', recipeId: value.recipeId })
  }
  return failure(`Unknown recipe step kind: ${value.kind}.`)
}

const BASE_STEP_KEYS = [
  'id',
  'target',
  'expectedContext',
  'onMissingTarget',
  'onContextMismatch',
  'timeoutMs',
  'waitBefore',
  'waitAfter',
] as const

function parseStepBase(value: Record<string, unknown>): RecipeParseResult<RecipeStepBase> {
  if (!validIdentifier(value.id)) return failure('Step ID is invalid.')
  const target = parseTarget(value.target)
  if (!target) return failure('Step target is invalid.')
  const expectedContext = parseExpectedContext(value.expectedContext)
  if (!expectedContext) return failure('Expected context is invalid.')
  if (value.onMissingTarget !== 'fail') return failure('Missing-target behavior must be fail.')
  if (value.onContextMismatch !== 'fail') return failure('Context-mismatch behavior must be fail.')
  if (!integerBetween(value.timeoutMs, 50, MAX_STEP_TIMEOUT_MS)) return failure(`Step timeout must be between 50 and ${MAX_STEP_TIMEOUT_MS} ms.`)
  const waitBefore = parseWaits(value.waitBefore)
  if (!waitBefore.ok) return failure(`Before-wait: ${waitBefore.error}`)
  const waitAfter = parseWaits(value.waitAfter)
  if (!waitAfter.ok) return failure(`After-wait: ${waitAfter.error}`)
  return success({
    id: value.id,
    target,
    expectedContext,
    onMissingTarget: 'fail',
    onContextMismatch: 'fail',
    timeoutMs: value.timeoutMs,
    ...(waitBefore.value ? { waitBefore: waitBefore.value } : {}),
    ...(waitAfter.value ? { waitAfter: waitAfter.value } : {}),
  })
}

function parseWaits(value: unknown): RecipeParseResult<RecipeWaitCondition[] | undefined> {
  if (value === undefined) return success(undefined)
  if (!Array.isArray(value) || value.length > MAX_WAITS_PER_STEP) return failure(`Expected at most ${MAX_WAITS_PER_STEP} wait conditions.`)
  const waits: RecipeWaitCondition[] = []
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.kind !== 'string') return failure('Wait condition is invalid.')
    if (raw.kind === 'delay') {
      if (!onlyKeys(raw, ['kind', 'milliseconds']) || !integerBetween(raw.milliseconds, 0, MAX_WAIT_MS)) return failure('Delay wait is invalid.')
      waits.push({ kind: 'delay', milliseconds: raw.milliseconds })
    } else if (raw.kind === 'target') {
      const target = parseTarget(raw.target)
      if (!onlyKeys(raw, ['kind', 'target', 'pollIntervalMs']) || !target || !integerBetween(raw.pollIntervalMs, 10, 1_000)) return failure('Target wait is invalid.')
      waits.push({ kind: 'target', target, pollIntervalMs: raw.pollIntervalMs })
    } else if (raw.kind === 'context') {
      const expectedContext = parseExpectedContext(raw.expectedContext)
      if (!onlyKeys(raw, ['kind', 'expectedContext', 'pollIntervalMs']) || !expectedContext || !integerBetween(raw.pollIntervalMs, 10, 1_000)) return failure('Context wait is invalid.')
      waits.push({ kind: 'context', expectedContext, pollIntervalMs: raw.pollIntervalMs })
    } else {
      return failure(`Unknown wait condition: ${raw.kind}.`)
    }
  }
  return success(waits)
}

function parseTarget(value: unknown): RecipeTarget | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null
  if (value.kind === 'application' && onlyKeys(value, ['kind'])) return { kind: 'application' }
  if (value.kind === 'active-workspace' && onlyKeys(value, ['kind'])) return { kind: 'active-workspace' }
  if (value.kind === 'workspace' && onlyKeys(value, ['kind', 'workspaceId']) && validIdentifier(value.workspaceId)) return { kind: 'workspace', workspaceId: value.workspaceId }
  if (value.kind === 'active-terminal' && onlyKeys(value, ['kind'])) return { kind: 'active-terminal' }
  if (value.kind === 'terminal' && onlyKeys(value, ['kind', 'workspaceId', 'terminalId']) && validIdentifier(value.workspaceId) && validIdentifier(value.terminalId)) {
    return { kind: 'terminal', workspaceId: value.workspaceId, terminalId: value.terminalId }
  }
  if (value.kind === 'view' && onlyKeys(value, ['kind', 'view']) && validView(value.view)) return { kind: 'view', view: value.view }
  return null
}

function parseExpectedContext(value: unknown): RecipeContextExpectation | null {
  if (!isRecord(value) || !onlyKeys(value, ['workspaceId', 'terminalId', 'view', 'fullscreen'])) return null
  if (value.workspaceId !== undefined && !validIdentifier(value.workspaceId)) return null
  if (value.terminalId !== undefined && !validIdentifier(value.terminalId)) return null
  if (value.view !== undefined && !validView(value.view)) return null
  if (value.fullscreen !== undefined && typeof value.fullscreen !== 'boolean') return null
  return {
    ...(value.workspaceId !== undefined ? { workspaceId: value.workspaceId } : {}),
    ...(value.terminalId !== undefined ? { terminalId: value.terminalId } : {}),
    ...(value.view !== undefined ? { view: value.view } : {}),
    ...(value.fullscreen !== undefined ? { fullscreen: value.fullscreen } : {}),
  }
}

export interface RecipeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type RecipeStoreResult<T = void> = { ok: true; value: T } | { ok: false; error: string }

export interface RecipeStore<Commands extends Record<string, JsonObject>> {
  getSnapshot(): RecipeDocument<Commands>
  getLoadError(): string | null
  subscribe(listener: () => void): () => void
  save(recipe: Recipe<Commands>): RecipeStoreResult<Recipe<Commands>>
  rename(recipeId: string, name: string): RecipeStoreResult<Recipe<Commands>>
  duplicate(recipeId: string): RecipeStoreResult<Recipe<Commands>>
  delete(recipeId: string): RecipeStoreResult
  reorderStep(recipeId: string, fromIndex: number, toIndex: number): RecipeStoreResult<Recipe<Commands>>
  removeStep(recipeId: string, stepIndex: number): RecipeStoreResult<Recipe<Commands>>
  replaceStep(recipeId: string, stepIndex: number, step: RecipeStep<Commands>): RecipeStoreResult<Recipe<Commands>>
  setBinding(recipeId: string, binding: string | null): RecipeStoreResult<Recipe<Commands>>
  undo(): RecipeStoreResult
  canUndo(): boolean
  exportJson(recipeId?: string): RecipeStoreResult<string>
  importJson(json: string, conflict?: 'reject' | 'replace'): RecipeStoreResult<Recipe<Commands>[]>
}

export interface CreateRecipeStoreOptions<Commands extends Record<string, JsonObject>> {
  registry: RecipeCommandRegistry<Commands>
  storage?: RecipeStorage
  storageKey?: string
  migrations?: readonly RecipeMigration[]
  maxUndo?: number
  now?: () => number
  idFactory?: () => string
}

export function createRecipeStore<Commands extends Record<string, JsonObject>>(
  options: CreateRecipeStoreOptions<Commands>,
): RecipeStore<Commands> {
  const storage = options.storage ?? browserStorage()
  const storageKey = options.storageKey ?? RECIPE_STORAGE_KEY
  const maxUndo = Math.max(1, Math.min(50, options.maxUndo ?? 20))
  const now = options.now ?? (() => Date.now())
  const idFactory = options.idFactory ?? defaultId
  const listeners = new Set<() => void>()
  const undoStack: RecipeDocument<Commands>[] = []
  let loadError: string | null = null
  let state: RecipeDocument<Commands> = { schemaVersion: RECIPE_SCHEMA_VERSION, recipes: [] }

  if (storage) {
    try {
      const saved = storage.getItem(storageKey)
      if (saved !== null) {
        const parsed = parseRecipeDocument(saved, options.registry, options.migrations)
        if (parsed.ok) state = parsed.value
        else loadError = parsed.error
      }
    } catch (error) {
      loadError = errorMessage(error, 'Recipe storage could not be read.')
    }
  }

  function persist(
    next: RecipeDocument<Commands>,
    previous?: RecipeDocument<Commands>,
    allowRecovery = false,
  ): RecipeStoreResult {
    if (loadError && !allowRecovery) {
      return failure(`Stored recipes must be repaired or explicitly replaced before editing: ${loadError}`)
    }
    const parsed = parseRecipeDocument(next, options.registry)
    if (!parsed.ok) return parsed
    try {
      storage?.setItem(storageKey, JSON.stringify(parsed.value))
      persistDurableUserConfigKey(storageKey)
    } catch (error) {
      return failure(errorMessage(error, 'Recipe storage could not be written.'))
    }
    if (previous) {
      undoStack.push(previous)
      if (undoStack.length > maxUndo) undoStack.shift()
    }
    state = parsed.value
    loadError = null
    listeners.forEach(listener => listener())
    return success(undefined)
  }

  function updateRecipe(recipeId: string, update: (recipe: Recipe<Commands>) => Recipe<Commands>): RecipeStoreResult<Recipe<Commands>> {
    const index = state.recipes.findIndex(recipe => recipe.id === recipeId)
    if (index < 0) return failure(`Recipe not found: ${recipeId}.`)
    const nextRecipe = update(state.recipes[index])
    const recipes = [...state.recipes]
    recipes[index] = nextRecipe
    const result = persist({ schemaVersion: RECIPE_SCHEMA_VERSION, recipes }, state)
    return result.ok ? success(state.recipes[index]) : result
  }

  return {
    getSnapshot: () => state,
    getLoadError: () => loadError,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    save(recipe) {
      const parsed = parseRecipe(recipe, options.registry)
      if (!parsed.ok) return parsed
      const index = state.recipes.findIndex(item => item.id === parsed.value.id)
      const recipes = [...state.recipes]
      if (index >= 0) recipes[index] = parsed.value
      else recipes.push(parsed.value)
      const result = persist({ schemaVersion: RECIPE_SCHEMA_VERSION, recipes }, state)
      return result.ok ? success(parsed.value) : result
    },
    rename(recipeId, name) {
      if (!boundedString(name, 1, 120) || name.trim() !== name) return failure('Recipe name is invalid.')
      return updateRecipe(recipeId, recipe => ({ ...recipe, name, updatedAt: Math.max(now(), recipe.updatedAt) }))
    },
    duplicate(recipeId) {
      const source = state.recipes.find(recipe => recipe.id === recipeId)
      if (!source) return failure(`Recipe not found: ${recipeId}.`)
      let id = idFactory()
      for (let attempts = 0; state.recipes.some(recipe => recipe.id === id) && attempts < 10; attempts += 1) id = idFactory()
      if (!validIdentifier(id) || state.recipes.some(recipe => recipe.id === id)) return failure('Could not allocate a unique recipe ID.')
      const timestamp = now()
      const duplicateCandidate = {
        ...source,
        id,
        name: `${source.name} copy`.slice(0, 120),
        binding: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      const parsedDuplicate = parseRecipe(duplicateCandidate, options.registry)
      if (!parsedDuplicate.ok) return parsedDuplicate
      const duplicate = parsedDuplicate.value
      const result = persist({ schemaVersion: RECIPE_SCHEMA_VERSION, recipes: [...state.recipes, duplicate] }, state)
      return result.ok ? success(duplicate) : result
    },
    delete(recipeId) {
      if (!state.recipes.some(recipe => recipe.id === recipeId)) return failure(`Recipe not found: ${recipeId}.`)
      return persist({ schemaVersion: RECIPE_SCHEMA_VERSION, recipes: state.recipes.filter(recipe => recipe.id !== recipeId) }, state)
    },
    reorderStep(recipeId, fromIndex, toIndex) {
      try {
        return updateRecipe(recipeId, recipe => {
          if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex < 0 || toIndex < 0 || fromIndex >= recipe.steps.length || toIndex >= recipe.steps.length) {
            throw new RecipeEditError('Step reorder indexes are out of range.')
          }
          const steps = [...recipe.steps]
          const [moved] = steps.splice(fromIndex, 1)
          steps.splice(toIndex, 0, moved)
          return { ...recipe, steps, updatedAt: Math.max(now(), recipe.updatedAt) }
        })
      } catch (error) {
        return failure(errorMessage(error, 'Recipe steps could not be reordered.'))
      }
    },
    removeStep(recipeId, stepIndex) {
      try {
        return updateRecipe(recipeId, recipe => {
          if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= recipe.steps.length) throw new RecipeEditError('Step index is out of range.')
          const steps = recipe.steps.filter((_, index) => index !== stepIndex)
          return { ...recipe, steps, updatedAt: Math.max(now(), recipe.updatedAt) }
        })
      } catch (error) {
        return failure(errorMessage(error, 'Recipe step could not be removed.'))
      }
    },
    replaceStep(recipeId, stepIndex, step) {
      try {
        return updateRecipe(recipeId, recipe => {
          if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= recipe.steps.length) throw new RecipeEditError('Step index is out of range.')
          const steps = [...recipe.steps]
          steps[stepIndex] = step
          return { ...recipe, steps, updatedAt: Math.max(now(), recipe.updatedAt) }
        })
      } catch (error) {
        return failure(errorMessage(error, 'Recipe step could not be replaced.'))
      }
    },
    setBinding(recipeId, binding) {
      if (binding !== null && !boundedString(binding, 1, 64)) return failure('Recipe binding is invalid.')
      return updateRecipe(recipeId, recipe => ({ ...recipe, binding, updatedAt: Math.max(now(), recipe.updatedAt) }))
    },
    undo() {
      const previous = undoStack[undoStack.length - 1]
      if (!previous) return failure('Nothing to undo.')
      const result = persist(previous)
      if (result.ok) undoStack.pop()
      return result
    },
    canUndo: () => undoStack.length > 0,
    exportJson(recipeId) {
      const recipes = recipeId === undefined ? state.recipes : state.recipes.filter(recipe => recipe.id === recipeId)
      if (recipeId !== undefined && recipes.length === 0) return failure(`Recipe not found: ${recipeId}.`)
      return success(JSON.stringify({ schemaVersion: RECIPE_SCHEMA_VERSION, recipes }, null, 2))
    },
    importJson(json, conflict = 'reject') {
      const parsed = parseRecipeDocument(json, options.registry, options.migrations)
      if (!parsed.ok) return parsed
      const incomingIds = new Set(parsed.value.recipes.map(recipe => recipe.id))
      const conflicts = state.recipes.filter(recipe => incomingIds.has(recipe.id)).map(recipe => recipe.id)
      if (conflict === 'reject' && conflicts.length > 0) return failure(`Recipe ID already exists: ${conflicts.join(', ')}.`)
      const retained = conflict === 'replace' ? state.recipes.filter(recipe => !incomingIds.has(recipe.id)) : state.recipes
      if (retained.length + parsed.value.recipes.length > MAX_RECIPES) return failure(`Recipe document must contain at most ${MAX_RECIPES} recipes.`)
      const result = persist({ schemaVersion: RECIPE_SCHEMA_VERSION, recipes: [...retained, ...parsed.value.recipes] }, state, true)
      return result.ok ? success(parsed.value.recipes) : result
    },
  }
}

class RecipeEditError extends Error {}

export type SemanticCommandDispatch<Commands extends Record<string, JsonObject>> = {
  [Id in keyof Commands & string]: {
    kind: 'semantic-command'
    origin: 'manual' | 'recipe'
    commandId: Id
    args: Commands[Id]
    target: RecipeTarget
    expectedContext: RecipeContextExpectation
    timeoutMs?: number
    waitBefore?: RecipeWaitCondition[]
    waitAfter?: RecipeWaitCondition[]
  }
}[keyof Commands & string]

export interface SemanticCommandSource<Commands extends Record<string, JsonObject>> {
  subscribe(listener: (event: SemanticCommandDispatch<Commands>) => void): () => void
}

export interface RecipeRecorder<Commands extends Record<string, JsonObject>> {
  getState(): Readonly<{ status: 'idle'; stepCount: 0 } | { status: 'recording'; stepCount: number }>
  start(): RecipeStoreResult
  stop(details: { id: string; name: string; description?: string }): RecipeParseResult<Recipe<Commands>>
  cancel(): void
}

export function createRecipeRecorder<Commands extends Record<string, JsonObject>>(options: {
  registry: RecipeCommandRegistry<Commands>
  source: SemanticCommandSource<Commands>
  stepIdFactory?: () => string
  now?: () => number
}): RecipeRecorder<Commands> {
  const stepIdFactory = options.stepIdFactory ?? defaultId
  const now = options.now ?? (() => Date.now())
  let steps: CommandRecipeStep<Commands>[] = []
  let unsubscribe: (() => void) | null = null

  function finish(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  return {
    getState: () => unsubscribe ? { status: 'recording', stepCount: steps.length } : { status: 'idle', stepCount: 0 },
    start() {
      if (unsubscribe) return failure('A recipe recording is already active.')
      steps = []
      unsubscribe = options.source.subscribe(event => {
        if (!isRecord(event) || event.kind !== 'semantic-command' || event.origin !== 'manual' || typeof event.commandId !== 'string') return
        if (steps.length >= MAX_STEPS || !options.registry.has(event.commandId)) return
        const args = options.registry.recordArgs(event.commandId, event.args)
        const target = parseTarget(event.target)
        const expectedContext = parseExpectedContext(event.expectedContext)
        const waitBefore = parseWaits(event.waitBefore)
        const waitAfter = parseWaits(event.waitAfter)
        const timeoutMs = event.timeoutMs ?? 10_000
        if (!args || !target || !expectedContext || !waitBefore.ok || !waitAfter.ok || !integerBetween(timeoutMs, 50, MAX_STEP_TIMEOUT_MS)) return
        steps.push({
          id: stepIdFactory(),
          kind: 'command',
          commandId: event.commandId,
          args,
          target,
          expectedContext,
          onMissingTarget: 'fail',
          onContextMismatch: 'fail',
          timeoutMs,
          ...(waitBefore.value ? { waitBefore: waitBefore.value } : {}),
          ...(waitAfter.value ? { waitAfter: waitAfter.value } : {}),
        } as CommandRecipeStep<Commands>)
      })
      return success(undefined)
    },
    stop(details) {
      if (!unsubscribe) return failure('No recipe recording is active.')
      finish()
      const timestamp = now()
      const parsed = parseRecipe({
        version: RECIPE_SCHEMA_VERSION,
        id: details.id,
        name: details.name,
        ...(details.description !== undefined ? { description: details.description } : {}),
        steps,
        createdAt: timestamp,
        updatedAt: timestamp,
      }, options.registry)
      steps = []
      return parsed
    },
    cancel() {
      finish()
      steps = []
    },
  }
}

export interface RecipeAuthorizationRequest {
  source: 'recipe'
  recipeId: string
  recipeName: string
  stepId: string
  commandId: string
  policy: RecipeAuthorizationPolicy
  target: RecipeTarget
  args: JsonObject
  advanced: boolean
  reviewSummary?: string
}

export interface RecipeExecutionDependencies<Commands extends Record<string, JsonObject>> {
  registry: RecipeCommandRegistry<Commands>
  getRecipe(recipeId: string): Recipe<Commands> | undefined
  getContext(): RecipeRuntimeContext | Promise<RecipeRuntimeContext>
  targetExists(target: RecipeTarget, context: RecipeRuntimeContext): boolean | Promise<boolean>
  /** Use the same callback used by manual semantic command dispatch. */
  authorize(request: RecipeAuthorizationRequest, signal: AbortSignal): boolean | Promise<boolean>
  dispatch(
    commandId: keyof Commands & string,
    args: Commands[keyof Commands & string],
    target: RecipeTarget,
    signal: AbortSignal,
  ): void | Promise<void>
  dispatchTerminalCommand(step: TerminalCommandRecipeStep, signal: AbortSignal): void | Promise<void>
  pause?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

export type RecipeReplayErrorCode =
  | 'recipe-not-found'
  | 'invalid-recipe'
  | 'recursion-limit'
  | 'step-limit'
  | 'missing-target'
  | 'context-mismatch'
  | 'unauthorized'
  | 'timed-out'
  | 'cancelled'
  | 'dispatch-failed'
  | 'wait-failed'

export interface RecipeReplayFailure {
  code: RecipeReplayErrorCode
  message: string
  recipeId: string
  stepId?: string
}

export type RecipeReplayResult =
  | { status: 'completed'; recipeId: string; stepsCompleted: number }
  | { status: 'cancelled'; recipeId: string; stepsCompleted: number; error: RecipeReplayFailure }
  | { status: 'failed'; recipeId: string; stepsCompleted: number; error: RecipeReplayFailure }

export interface RecipeReplayHandle {
  result: Promise<RecipeReplayResult>
  cancel(reason?: string): void
}

export function createRecipeExecutor<Commands extends Record<string, JsonObject>>(
  dependencies: RecipeExecutionDependencies<Commands>,
  limits: { maxDepth?: number; maxTotalSteps?: number } = {},
): { start(recipeId: string, signal?: AbortSignal): RecipeReplayHandle } {
  const maxDepth = Math.max(1, Math.min(MAX_RECURSION_DEPTH, limits.maxDepth ?? MAX_RECURSION_DEPTH))
  const maxTotalSteps = Math.max(1, Math.min(MAX_TOTAL_REPLAY_STEPS, limits.maxTotalSteps ?? MAX_TOTAL_REPLAY_STEPS))
  const pause = dependencies.pause ?? defaultPause

  return {
    start(recipeId, outerSignal) {
      const controller = new AbortController()
      const relayAbort = () => controller.abort(outerSignal?.reason)
      outerSignal?.addEventListener('abort', relayAbort, { once: true })
      if (outerSignal?.aborted) controller.abort(outerSignal.reason)
      let completed = 0

      const result = (async (): Promise<RecipeReplayResult> => {
        try {
          await executeRecipe(recipeId, [], controller.signal)
          return { status: 'completed', recipeId, stepsCompleted: completed }
        } catch (error) {
          const replayError = asReplayError(error, recipeId)
          const status = replayError.code === 'cancelled' ? 'cancelled' : 'failed'
          return { status, recipeId, stepsCompleted: completed, error: replayError }
        } finally {
          outerSignal?.removeEventListener('abort', relayAbort)
        }
      })()

      async function executeRecipe(currentRecipeId: string, stack: string[], recipeSignal: AbortSignal): Promise<void> {
        if (recipeSignal.aborted) throw new ReplayError('cancelled', abortMessage(recipeSignal), currentRecipeId)
        if (stack.includes(currentRecipeId) || stack.length >= maxDepth) {
          throw new ReplayError('recursion-limit', `Recipe recursion is limited to ${maxDepth} levels.`, currentRecipeId)
        }
        const rawRecipe = dependencies.getRecipe(currentRecipeId)
        if (!rawRecipe) throw new ReplayError('recipe-not-found', `Recipe not found: ${currentRecipeId}.`, currentRecipeId)
        const parsed = parseRecipe(rawRecipe, dependencies.registry)
        if (!parsed.ok) throw new ReplayError('invalid-recipe', parsed.error, currentRecipeId)
        const recipe = parsed.value
        const nextStack = [...stack, currentRecipeId]

        for (const step of recipe.steps) {
          if (completed >= maxTotalSteps) throw new ReplayError('step-limit', `Replay is limited to ${maxTotalSteps} total steps.`, currentRecipeId, step.id)
          await withStepDeadline(currentRecipeId, step, recipeSignal, async stepSignal => {
            await runWaits(step.waitBefore, currentRecipeId, step.id, stepSignal)
            const context = await dependencies.getContext()
            if (!matchesExpectedContext(context, step.expectedContext)) {
              throw new ReplayError('context-mismatch', 'The expected recipe context is no longer active.', currentRecipeId, step.id)
            }
            if (!(await dependencies.targetExists(step.target, context))) {
              throw new ReplayError('missing-target', 'The recipe target is not available.', currentRecipeId, step.id)
            }

            if (step.kind === 'command') {
              const policy = dependencies.registry.authorizationFor(step.commandId)
              const args = dependencies.registry.parseArgs(step.commandId, step.args)
              if (!policy || !args) throw new ReplayError('invalid-recipe', `Command is not allowlisted: ${step.commandId}.`, currentRecipeId, step.id)
              const allowed = await dependencies.authorize({
                source: 'recipe', recipeId: recipe.id, recipeName: recipe.name, stepId: step.id,
                commandId: step.commandId, policy, target: step.target, args, advanced: false,
              }, stepSignal)
              if (!allowed) throw new ReplayError('unauthorized', `Authorization was denied for ${step.commandId}.`, currentRecipeId, step.id)
              await dependencies.dispatch(step.commandId, args as Commands[keyof Commands & string], step.target, stepSignal)
            } else if (step.kind === 'terminal-command') {
              const args: JsonObject = {
                command: step.command,
                ...(step.workingDirectory ? { workingDirectory: step.workingDirectory } : {}),
              }
              const allowed = await dependencies.authorize({
                source: 'recipe', recipeId: recipe.id, recipeName: recipe.name, stepId: step.id,
                commandId: 'terminal-command', policy: 'terminal-command', target: step.target,
                args, advanced: true, reviewSummary: step.review.summary,
              }, stepSignal)
              if (!allowed) throw new ReplayError('unauthorized', 'Authorization was denied for the terminal command.', currentRecipeId, step.id)
              await dependencies.dispatchTerminalCommand(step, stepSignal)
            } else {
              await executeRecipe(step.recipeId, nextStack, stepSignal)
            }
            await runWaits(step.waitAfter, currentRecipeId, step.id, stepSignal)
          })
          completed += 1
        }
      }

      async function runWaits(
        waits: RecipeWaitCondition[] | undefined,
        currentRecipeId: string,
        stepId: string,
        signal: AbortSignal,
      ): Promise<void> {
        for (const wait of waits ?? []) {
          if (wait.kind === 'delay') {
            await pause(wait.milliseconds, signal)
            continue
          }
          while (true) {
            if (signal.aborted) throw new ReplayError('cancelled', abortMessage(signal), currentRecipeId, stepId)
            const context = await dependencies.getContext()
            const ready = wait.kind === 'target'
              ? await dependencies.targetExists(wait.target, context)
              : matchesExpectedContext(context, wait.expectedContext)
            if (ready) break
            try {
              await pause(wait.pollIntervalMs, signal)
            } catch (error) {
              if (signal.aborted) throw new ReplayError('cancelled', abortMessage(signal), currentRecipeId, stepId)
              throw new ReplayError('wait-failed', errorMessage(error, 'Recipe wait failed.'), currentRecipeId, stepId)
            }
          }
        }
      }

      return {
        result,
        cancel(reason = 'Recipe replay was cancelled.') {
          controller.abort(reason)
        },
      }
    },
  }
}

async function withStepDeadline(
  recipeId: string,
  step: RecipeStep,
  parentSignal: AbortSignal,
  task: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController()
  let timedOut = false
  const relayAbort = () => controller.abort(parentSignal.reason)
  parentSignal.addEventListener('abort', relayAbort, { once: true })
  if (parentSignal.aborted) controller.abort(parentSignal.reason)
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort('Step timed out.')
  }, step.timeoutMs)
  const aborted = new Promise<never>((_, reject) => {
    const rejectAbort = () => reject(new ReplayError(
      timedOut ? 'timed-out' : 'cancelled',
      timedOut ? `Step timed out after ${step.timeoutMs} ms.` : abortMessage(controller.signal),
      recipeId,
      step.id,
    ))
    if (controller.signal.aborted) rejectAbort()
    else controller.signal.addEventListener('abort', rejectAbort, { once: true })
  })
  try {
    await Promise.race([task(controller.signal), aborted])
  } catch (error) {
    if (timedOut) throw new ReplayError('timed-out', `Step timed out after ${step.timeoutMs} ms.`, recipeId, step.id)
    if (parentSignal.aborted) throw new ReplayError('cancelled', abortMessage(parentSignal), recipeId, step.id)
    if (error instanceof ReplayError) throw error
    throw new ReplayError('dispatch-failed', errorMessage(error, 'Recipe step failed.'), recipeId, step.id)
  } finally {
    clearTimeout(timer)
    parentSignal.removeEventListener('abort', relayAbort)
  }
}

export function matchesExpectedContext(context: RecipeRuntimeContext, expected: RecipeContextExpectation): boolean {
  return (expected.workspaceId === undefined || context.workspaceId === expected.workspaceId)
    && (expected.terminalId === undefined || context.terminalId === expected.terminalId)
    && (expected.view === undefined || context.view === expected.view)
    && (expected.fullscreen === undefined || context.fullscreen === expected.fullscreen)
}

class ReplayError extends Error {
  constructor(
    readonly code: RecipeReplayErrorCode,
    message: string,
    readonly recipeId: string,
    readonly stepId?: string,
  ) {
    super(message)
  }
}

function asReplayError(error: unknown, recipeId: string): RecipeReplayFailure {
  if (error instanceof ReplayError) return { code: error.code, message: error.message, recipeId: error.recipeId, ...(error.stepId ? { stepId: error.stepId } : {}) }
  return { code: 'dispatch-failed', message: errorMessage(error, 'Recipe replay failed.'), recipeId }
}

function migrateDocument(raw: unknown, migrations: readonly RecipeMigration[]): RecipeParseResult<unknown> {
  if (!isRecord(raw) || !Number.isInteger(raw.schemaVersion) || (raw.schemaVersion as number) < 0) {
    return failure('Recipe document has no valid schemaVersion.')
  }
  let current: unknown = raw
  let version = raw.schemaVersion as number
  if (version > RECIPE_SCHEMA_VERSION) return failure(`Recipe schema version ${version} is newer than this app supports.`)
  const visited = new Set<number>()
  while (version < RECIPE_SCHEMA_VERSION) {
    if (visited.has(version)) return failure('Recipe migration cycle detected.')
    visited.add(version)
    const migration = migrations.find(item => item.from === version)
    if (!migration || migration.to !== version + 1 || migration.to > RECIPE_SCHEMA_VERSION) {
      return failure(`No safe recipe migration exists from schema version ${version}.`)
    }
    try {
      current = migration.migrate(current)
    } catch (error) {
      return failure(errorMessage(error, `Recipe migration from version ${version} failed.`))
    }
    if (!isRecord(current) || current.schemaVersion !== migration.to) {
      return failure(`Recipe migration from version ${version} returned an invalid boundary.`)
    }
    version = migration.to
  }
  return success(current)
}

function defaultPause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(abortMessage(signal)))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = () => {
      clearTimeout(timer)
      reject(new Error(abortMessage(signal)))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function browserStorage(): RecipeStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

function defaultId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `recipe-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }
}

function validJsonObject(value: unknown): value is JsonObject {
  return validateJson(value, 0, { entries: 0 }) && !Array.isArray(value) && value !== null
}

function validateJson(value: unknown, depth: number, state: { entries: number }): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || depth >= MAX_JSON_DEPTH) return false
  if (Array.isArray(value)) {
    state.entries += value.length
    return state.entries <= MAX_JSON_ENTRIES && value.every(item => validateJson(item, depth + 1, state))
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const entries = Object.entries(value)
  state.entries += entries.length
  return state.entries <= MAX_JSON_ENTRIES && entries.every(([, item]) => validateJson(item, depth + 1, state))
}

function cloneJsonObject(value: JsonObject): JsonObject {
  const result: JsonObject = Object.create(null) as JsonObject
  for (const [key, item] of Object.entries(value)) result[key] = cloneJson(item)
  return result
}

function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJson)
  if (value && typeof value === 'object') return cloneJsonObject(value)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every(key => allowed.has(key))
}

function validIdentifier(value: unknown): value is string {
  return boundedString(value, 1, 256) && !/[\u0000-\u001f\u007f]/.test(value)
}

function boundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum
}

function validTimestamp(value: unknown): value is number {
  return integerBetween(value, 0, Number.MAX_SAFE_INTEGER)
}

function integerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
}

function validView(value: unknown): value is RecipeView {
  return value === 'terminal' || value === 'board' || value === 'designer' || value === 'files' || value === 'settings'
}

function abortMessage(signal: AbortSignal): string {
  return typeof signal.reason === 'string' && signal.reason ? signal.reason : 'Recipe replay was cancelled.'
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function success<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

function failure(error: string): { ok: false; error: string } {
  return { ok: false, error }
}
