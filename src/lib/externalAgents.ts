// Bring a terminal from outside the app into a split (Code-7xc.4).
//
// macOS does not let one app take over another app's live PTY, so this opens
// a split in the same folder and continues the exact conversation that was
// running there (after one confirm that stops the outside CLI). A tmux
// session is the exception: it can be attached live and stays shared.

import { invoke } from '@tauri-apps/api/core'
import { abbreviatePath } from './abbreviatePath'
import { shellQuote } from './shellQuote'
import { pushNoticeToast } from './invokeErrorBoundary'
import { requestDestructiveAction } from '../state/destructiveActions'
import { agentLaunchCommand } from '../state/sessionPreferences'
import { agentResumeCommand, agentStartCommand, isAgentSessionId } from '../state/agentHooks'
import { openSplitInFolder } from '../state/termPanes'
import { setSkin } from '../state/skin'

export interface ExternalAgent {
  pid: number
  cli: 'claude' | 'codex' | 'gemini'
  cwd: string | null
  tty: string | null
  app: string | null
  tmuxSession: string | null
  sessionId: string | null
}

const CLI_LABEL = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' } as const

export const OUTSIDE_WINDOW_HINT = 'The outside window stays open as an idle shell; close it yourself.'

export function listExternalAgents(): Promise<ExternalAgent[]> {
  return invoke<ExternalAgent[]>('external_agents')
}

/** "Claude · ~/Desktop/Code/foo · Terminal · session 1a2b…", tmux entries marked live attach. */
export function externalAgentLabel(agent: ExternalAgent): string {
  const parts: string[] = [CLI_LABEL[agent.cli]]
  if (agent.cwd) parts.push(abbreviatePath(agent.cwd))
  if (agent.tmuxSession) parts.push(`tmux ${agent.tmuxSession} (live attach)`)
  else if (agent.app) parts.push(agent.app)
  if (isAgentSessionId(agent.sessionId)) parts.push(`session ${agent.sessionId.slice(0, 4)}…`)
  else if (!agent.tmuxSession) parts.push('conversation unknown')
  return parts.join(' · ')
}

export interface AdoptPlan {
  kind: 'tmux' | 'resume' | 'start'
  command: string
  /** False when nothing may be submitted: a start line with no conversation to resume. */
  submit: boolean
  cwd: string | null
  /** Stop the outside process first. */
  stop: boolean
}

function geminiResume(id: string | null): string {
  const base = agentLaunchCommand('gemini')
  return isAgentSessionId(id) ? `${base} --resume ${id}` : base
}

/** What adopting this agent runs in the new split. Never submits an agent prompt. */
export function adoptPlan(agent: ExternalAgent): AdoptPlan {
  if (agent.tmuxSession) {
    // `=` makes tmux match the session name exactly instead of by prefix.
    return { kind: 'tmux', command: `tmux attach -t ${shellQuote(`=${agent.tmuxSession}`)}`, submit: true, cwd: agent.cwd, stop: false }
  }
  if (isAgentSessionId(agent.sessionId)) {
    const command = agent.cli === 'gemini' ? geminiResume(agent.sessionId) : agentResumeCommand(agent.cli, agent.sessionId)
    return { kind: 'resume', command, submit: true, cwd: agent.cwd, stop: true }
  }
  // The conversation could not be identified: type the start command, leave Enter to the user.
  const command = agent.cli === 'gemini' ? geminiResume(null) : agentStartCommand(agent.cli)
  return { kind: 'start', command, submit: false, cwd: agent.cwd, stop: true }
}

export function adoptConfirmation(agent: ExternalAgent): { title: string; detail: string } {
  const where = agent.cwd ? abbreviatePath(agent.cwd) : 'its folder'
  if (agent.tmuxSession) {
    return {
      title: `Attach to tmux session ${agent.tmuxSession} here?`,
      detail: `It stays shared with the outside window: both show the same session. Nothing is stopped. (${CLI_LABEL[agent.cli]} in ${where})`,
    }
  }
  const outside = agent.app ? ` in ${agent.app}` : ''
  return {
    title: `Stop ${CLI_LABEL[agent.cli]}${outside} (folder ${where}) and continue this conversation here?`,
    detail: `${OUTSIDE_WINDOW_HINT}${isAgentSessionId(agent.sessionId) ? '' : ' The conversation could not be identified, so the start command is typed here without pressing Enter.'}`,
  }
}

async function stopOutside(pid: number): Promise<boolean> {
  try {
    return (await invoke<{ exited: boolean }>('external_agent_stop', { pid })).exited
  } catch (error) {
    pushNoticeToast(`Could not stop the outside process: ${String(error)}`)
    return false
  }
}

/** Ask once, then act. The confirm is never skipped: it stops another app's process. */
export function adoptExternalAgent(agent: ExternalAgent): void {
  const plan = adoptPlan(agent)
  const { title, detail } = adoptConfirmation(agent)
  requestDestructiveAction({
    kind: 'external-process',
    always: true,
    title,
    detail,
    onConfirm: async () => {
      if (plan.stop && !(await stopOutside(agent.pid))) {
        pushNoticeToast(`${CLI_LABEL[agent.cli]} did not exit, so it is still running outside. Nothing was opened.`)
        return
      }
      setSkin('terminal')
      openSplitInFolder(plan.cwd ?? '', plan.command, plan.submit)
      if (plan.kind === 'start') pushNoticeToast(`Could not identify the ${CLI_LABEL[agent.cli]} conversation. Started in the folder; press Enter to start a new one.`)
    },
  })
}

export function agentsInFolder(agents: ExternalAgent[], folder: string): ExternalAgent[] {
  const clean = (path: string) => path.replace(/\/+$/, '')
  return agents.filter(agent => agent.cwd !== null && clean(agent.cwd) === clean(folder))
}

export const EXTERNAL_PICKER_EVENT = 'bs:external-picker'

/** Show the picker of outside agents, optionally narrowed to one folder. */
export function openExternalPicker(folder: string | null = null): void {
  setSkin('terminal')
  window.dispatchEvent(new CustomEvent(EXTERNAL_PICKER_EVENT, { detail: { folder } }))
}

/**
 * A folder was dropped (a terminal's title-bar proxy icon, Finder, or Option
 * on a pane). An outside agent running in exactly that folder is offered; with
 * none, a split simply opens there.
 */
export async function bringInFolder(folder: string): Promise<void> {
  let matches: ExternalAgent[] = []
  try { matches = agentsInFolder(await listExternalAgents(), folder) } catch { /* open the folder anyway */ }
  if (matches.length === 1) { adoptExternalAgent(matches[0]); return }
  if (matches.length > 1) { openExternalPicker(folder); return }
  setSkin('terminal')
  openSplitInFolder(folder)
}
