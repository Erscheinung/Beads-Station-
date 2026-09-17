import { useEffect, useMemo, useState } from 'react'
import { clearRecipeBinding, getRecipeBinding, getRecipeBindings, setRecipeBinding } from '../state/commands'
import {
  cancelRecipeRecording,
  cancelRecipeReplay,
  createRecipeId,
  getLastRecipeReplayStatus,
  getRecipeRuntimeContext,
  recipeStore,
  reviewWorkspaceFixture,
  startRecipeRecording,
  startRecipeReplay,
  stopRecipeRecording,
  useRecipeRecording,
  useRecipeStoreSnapshot,
  RECIPE_REGISTRY,
  type AppRecipe,
} from '../state/recipeIntegration'
import { parseRecipe } from '../state/recipes'

function stepSummary(step: AppRecipe['steps'][number]): string {
  if (step.kind === 'command') return step.commandId
  if (step.kind === 'recipe') return `Recipe: ${step.recipeId}`
  return `Advanced terminal command: ${step.review.summary}`
}

export function RecipeSettings() {
  const document = useRecipeStoreSnapshot()
  const recording = useRecipeRecording()
  const context = getRecipeRuntimeContext()
  const [pending, setPending] = useState<AppRecipe | null>(null)
  const [pendingName, setPendingName] = useState('Untitled recipe')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [importText, setImportText] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [stepEdits, setStepEdits] = useState<Record<string, string>>({})
  const [bindingEdits, setBindingEdits] = useState<Record<string, string>>({})
  const replayStatus = getLastRecipeReplayStatus()
  const selected = useMemo(() => document.recipes.find(recipe => recipe.id === selectedId) ?? document.recipes[0] ?? null, [document.recipes, selectedId])

  // The persisted recipe document is authoritative after restart, import, or
  // undo. Keep the existing command registry's dynamic bindings synchronized
  // with it so a reverted binding cannot remain active in the global matcher.
  useEffect(() => {
    const present = new Set(document.recipes.map(recipe => recipe.id))
    for (const recipe of document.recipes) {
      if (recipe.binding) setRecipeBinding(recipe.id, recipe.name, recipe.binding)
      else clearRecipeBinding(recipe.id)
    }
    for (const recipeId of Object.keys(getRecipeBindings())) {
      if (!present.has(recipeId)) clearRecipeBinding(recipeId)
    }
  }, [document.recipes])

  const report = (result: { ok: true } | { ok: false; error: string }) => {
    setMessage(result.ok ? 'Saved.' : result.error)
  }

  const stop = () => {
    const result = stopRecipeRecording({ id: createRecipeId(), name: 'Untitled recipe' })
    if (result.ok) {
      setPending(result.value)
      setPendingName(result.value.name)
      setMessage(`Captured ${result.value.steps.length} semantic app steps. Name it before saving.`)
    } else setMessage(result.error)
  }

  const savePending = () => {
    if (!pending || !pendingName.trim()) {
      setMessage('Enter a recipe name before saving.')
      return
    }
    report(recipeStore.save({ ...pending, name: pendingName.trim(), updatedAt: Date.now() }))
    setPending(null)
  }

  const saveBinding = (recipe: AppRecipe) => {
    const value = (bindingEdits[recipe.id] ?? getRecipeBinding(recipe.id)).trim()
    if (!value) {
      clearRecipeBinding(recipe.id)
      report(recipeStore.setBinding(recipe.id, null))
      return
    }
    const error = setRecipeBinding(recipe.id, recipe.name, value)
    if (error) {
      setMessage(error)
      return
    }
    report(recipeStore.setBinding(recipe.id, value))
  }

  const editStep = (recipe: AppRecipe, index: number, value: string) => {
    const step = recipe.steps[index]
    if (!step || step.kind !== 'command') {
      setMessage('Only typed semantic command arguments are editable here.')
      return
    }
    try {
      const args = JSON.parse(value) as unknown
      const replacement = { ...step, args }
      const parsed = parseRecipe({ ...recipe, steps: recipe.steps.map((item, itemIndex) => itemIndex === index ? replacement : item) }, RECIPE_REGISTRY)
      if (!parsed.ok) {
        setMessage(parsed.error)
        return
      }
      report(recipeStore.replaceStep(recipe.id, index, parsed.value.steps[index]))
    } catch {
      setMessage('Arguments must be valid JSON for the selected command.')
    }
  }

  const exportRecipe = () => {
    const result = recipeStore.exportJson(selected?.id)
    if (result.ok) {
      setImportText(result.value)
      setMessage('Recipe JSON is ready to copy or save.')
    } else setMessage(result.error)
  }

  const importRecipes = () => {
    if (!importText.trim()) {
      setMessage('Paste a recipe JSON document before importing.')
      return
    }
    const result = recipeStore.importJson(importText)
    if (!result.ok) {
      setMessage(result.error)
      return
    }
    for (const recipe of result.value) {
      if (recipe.binding) {
        const bindingError = setRecipeBinding(recipe.id, recipe.name, recipe.binding)
        if (bindingError) {
          setMessage(`Imported recipe ${recipe.name}, but its shortcut was not applied: ${bindingError}`)
          return
        }
      } else clearRecipeBinding(recipe.id)
    }
    setMessage(`Imported ${result.value.length} recipe${result.value.length === 1 ? '' : 's'}.`)
  }

  const addFixture = () => {
    if (!context.workspaceId) {
      setMessage('Open a workspace before creating the Review workspace fixture.')
      return
    }
    report(recipeStore.save(reviewWorkspaceFixture(context.workspaceId)))
  }

  return <section aria-labelledby="recipes-settings-title">
    <h4 id="recipes-settings-title">Named interaction recipes</h4>
    <p className="bs-settings__note">Recipes capture explicit semantic app actions such as selecting a workspace, splitting a pane, focusing it, and showing the board. Terminal typing, clipboard contents, passwords, and provider output are never recorded.</p>
    {recording.status === 'recording' ? <div role="status" className="bs-settings__recipe-status"><strong>Recording · {recording.stepCount} steps</strong><span>Use the app normally, then stop to review the captured steps.</span><div><button onClick={stop}>Stop and review</button><button onClick={() => { cancelRecipeRecording(); setMessage('Recording cancelled.') }}>Cancel recording</button></div></div> : <button onClick={() => { const result = startRecipeRecording(); setMessage(result.ok ? 'Recording started. Only semantic app commands are captured.' : result.error) }}>Start recording</button>}
    {pending && <div className="bs-settings__recipe-status" aria-label="Save recorded recipe">
      <label>Name recorded recipe<input aria-label="Recorded recipe name" value={pendingName} onChange={event => setPendingName(event.target.value)} /></label>
      <details open><summary>Inspect captured steps ({pending.steps.length})</summary><ol aria-label="Captured recipe steps">{pending.steps.map((step, index) => <li key={step.id}>{index + 1}. {stepSummary(step)}</li>)}</ol></details>
      <button onClick={savePending}>Save recipe</button><button onClick={() => { setPending(null); setMessage('Captured recipe discarded.') }}>Discard</button>
    </div>}
    <div className="bs-settings__recipe-actions"><button onClick={addFixture} disabled={!context.workspaceId}>Create Review workspace fixture</button><button onClick={exportRecipe} disabled={!selected}>Export selected</button><button onClick={() => report(recipeStore.undo())} disabled={!recipeStore.canUndo()}>Undo last recipe edit</button></div>
    {message && <p role="status" className="bs-settings__note">{message}</p>}
    {replayStatus && <p role="status" className="bs-settings__note">Last replay: {replayStatus}</p>}
    {document.recipes.length === 0 ? <p className="bs-settings__note">No recipes saved yet.</p> : <div aria-label="Saved recipes">
      {document.recipes.map(recipe => <article key={recipe.id} className="bs-settings__recipe-card">
        <div className="bs-settings__recipe-heading"><button aria-expanded={selected?.id === recipe.id} onClick={() => setSelectedId(selected?.id === recipe.id ? null : recipe.id)}>{recipe.name}</button><span>{recipe.steps.length} steps</span></div>
        {selected?.id === recipe.id && <div className="bs-settings__recipe-editor">
          <label>Rename<input aria-label={`Rename ${recipe.name}`} value={recipe.name} onChange={event => { const result = recipeStore.rename(recipe.id, event.target.value); if (!result.ok) setMessage(result.error) }} /></label>
          <div className="bs-settings__recipe-actions"><button onClick={() => report(recipeStore.duplicate(recipe.id))}>Duplicate</button><button onClick={() => { clearRecipeBinding(recipe.id); report(recipeStore.delete(recipe.id)); setSelectedId(null) }}>Delete</button><button onClick={() => { const handle = startRecipeReplay(recipe.id); void handle.result.then(result => setMessage(result.status === 'completed' ? `Replay completed: ${result.stepsCompleted} steps.` : result.error.message)) }}>Replay</button><button onClick={() => cancelRecipeReplay()}>Cancel replay</button></div>
          <label>Shortcut binding<small>Uses the shared Command/Control conflict checker; leave blank to clear.</small><input aria-label={`Shortcut binding for ${recipe.name}`} placeholder="Mod+Shift+R" value={bindingEdits[recipe.id] ?? getRecipeBinding(recipe.id)} onChange={event => setBindingEdits(previous => ({ ...previous, [recipe.id]: event.target.value }))} /><button onClick={() => saveBinding(recipe)}>Save binding</button></label>
          <ol aria-label={`Steps for ${recipe.name}`}>
            {recipe.steps.map((step, index) => <li key={step.id}>
              <span>{stepSummary(step)}</span>
              <button aria-label={`Move step ${index + 1} up`} disabled={index === 0} onClick={() => report(recipeStore.reorderStep(recipe.id, index, index - 1))}>↑</button>
              <button aria-label={`Move step ${index + 1} down`} disabled={index === recipe.steps.length - 1} onClick={() => report(recipeStore.reorderStep(recipe.id, index, index + 1))}>↓</button>
              <button aria-label={`Remove step ${index + 1}`} onClick={() => report(recipeStore.removeStep(recipe.id, index))}>Remove</button>
              {step.kind === 'command' && <><textarea aria-label={`Arguments for step ${index + 1}`} value={stepEdits[step.id] ?? JSON.stringify(step.args)} onChange={event => setStepEdits(previous => ({ ...previous, [step.id]: event.target.value }))} /><button onClick={() => editStep(recipe, index, stepEdits[step.id] ?? JSON.stringify(step.args))}>Save arguments</button></>}
            </li>)}
          </ol>
        </div>}
      </article>)}
    </div>}
    <label>Import recipe JSON<textarea aria-label="Import recipe JSON" value={importText} onChange={event => setImportText(event.target.value)} placeholder="Paste an exported recipe document…" /></label><div className="bs-settings__recipe-actions"><button onClick={importRecipes}>Import recipes</button></div>
  </section>
}
