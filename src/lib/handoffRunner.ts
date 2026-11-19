// Gathers what a handoff note needs, writes it through the backend and tells
// the user (Code-7xc.2). Reads files and writes one markdown note; it never
// starts an agent, never sends anything to a model and never types into a pane.

import { invoke } from '@tauri-apps/api/core'
import { activeTerminalPaneId } from '../state/termPanes'
import { getPaneUsage, paneUsageEntries, subscribePaneUsage, type PaneUsage } from '../state/paneUsage'
import { agentLaunchCommand, handoffThreshold, obsidianVaultPath } from '../state/sessionPreferences'
import { openDesignerView } from '../state/designerNav'
import { addShelfItem } from '../components/designer/shelf'
import { fileChanges } from '../components/designer/sessionChanges'
import type { ArtifactRevision } from '../components/designer/artifacts'
import { peekBdIssues } from './bdCache'
import { pushNoticeToast } from './invokeErrorBoundary'
import { openInEditor } from './openInEditor'
import { activeWorkspace, paneWorkspace } from './paneWorkspace'
import { buildHandoffMarkdown, HandoffLedger, HandoffTrigger, type HandoffFacts, type HandoffReason } from './handoff'

function fileName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/** The user's own launch command plus the CLI's resume flag: runnable in any terminal, with no app-specific settings file. */
function plainResumeCommand(provider: 'claude' | 'codex', sessionId: string): string {
  const base = agentLaunchCommand(provider)
  return provider === 'claude' ? `${base} --resume ${sessionId}` : `${base} resume ${sessionId}`
}

/** Write a handoff for one pane. Resolves false when nothing was written. */
export async function saveHandoff(paneId: string, reason: HandoffReason): Promise<boolean> {
  const usage: PaneUsage | null = getPaneUsage(paneId)
  const workspace = paneWorkspace(paneId)
  if (!usage || !workspace) {
    if (reason === 'manual') pushNoticeToast('No agent is running in this pane, so there is nothing to hand off.')
    return false
  }
  const readable = usage.provider === 'claude' || usage.provider === 'codex'
  const facts = readable && usage.sessionId
    ? await invoke<HandoffFacts>('handoff_collect', { provider: usage.provider, sessionId: usage.sessionId, recent: 5 }).catch(() => null)
    : null
  const changes = await invoke<ArtifactRevision | null>('artifact_preview', { workspacePath: workspace.path })
    .then(revision => (revision ? fileChanges(revision).map(c => ({ path: c.path, kind: c.kind, added: c.added, removed: c.removed })) : []))
    .catch(() => null)
  const markdown = buildHandoffMarkdown({
    now: new Date(),
    workspaceName: workspace.name,
    workspacePath: workspace.path,
    provider: usage.provider,
    sessionId: usage.sessionId,
    usage,
    reason,
    facts,
    changes,
    beadIds: peekBdIssues(workspace.path).map(issue => issue.id),
    resumeCommand: readable && usage.sessionId ? plainResumeCommand(usage.provider as 'claude' | 'codex', usage.sessionId) : null,
  })
  try {
    const path = await invoke<string>('handoff_write', { workspace: workspace.path, provider: usage.provider, sessionId: usage.sessionId, markdown, vault: obsidianVaultPath() })
    addShelfItem(workspace.id, { kind: 'file', value: path, label: `Handoff ${fileName(path).replace(/\.md$/, '')}`, source: 'Handoff' })
    pushNoticeToast(`Handoff saved: ${fileName(path)}`, { label: 'Open in Pinned', run: () => openDesignerView('shelf') })
    return true
  } catch (error) {
    pushNoticeToast(`Could not save the handoff: ${String(error)}`)
    return false
  }
}

/** The command: hand off the agent in the focused pane (or the Designer session's). */
export function saveHandoffNow(): void {
  let paneId = activeTerminalPaneId()
  if (!getPaneUsage(paneId)) {
    const workspace = activeWorkspace()
    if (workspace && getPaneUsage(`designer:${workspace.id}`)) paneId = `designer:${workspace.id}`
  }
  void saveHandoff(paneId, 'manual')
}

/** Watch every pane's usage and write a note once when it crosses the threshold. Returns a stop function. */
export function startHandoffWatcher(): () => void {
  const trigger = new HandoffTrigger({
    threshold: handoffThreshold,
    ledger: new HandoffLedger(),
    save: saveHandoff,
  })
  const check = () => { for (const [paneId, usage] of paneUsageEntries()) trigger.check(paneId, usage) }
  check()
  return subscribePaneUsage(check)
}

/** The command: open the workspace's prompt journal in the editor. */
export async function openPromptJournal(): Promise<void> {
  const workspace = activeWorkspace()
  if (!workspace) { pushNoticeToast('Open a workspace first.'); return }
  try {
    const path = await invoke<string>('journal_path', { workspace: workspace.path })
    const [kind] = await invoke<string[]>('pin_kinds', { paths: [path] })
    if (kind !== 'file') { pushNoticeToast('No prompts have been journaled in this workspace yet.'); return }
    addShelfItem(workspace.id, { kind: 'file', value: path, label: 'Prompt journal', source: 'Journal' })
    await openInEditor({ path }, { cwd: workspace.path })
  } catch (error) {
    pushNoticeToast(`Could not open the prompt journal: ${String(error)}`)
  }
}
