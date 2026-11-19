// "Fork here" on a conversation message (Code-7xc.9, borrowed from pi's /fork).
// Neither CLI can fork at a single message, so this forks the whole session
// into a new terminal split and says so. The user clicked, so the command runs.

import { agentForkCommand, type AgentCli } from '../state/agentHooks'
import { openSplitInFolder } from '../state/termPanes'
import { setSkin } from '../state/skin'
import { pushNoticeToast } from './invokeErrorBoundary'

/** Providers with a fork command; Qwen has none, so its turns show no Fork action. */
export function canFork(provider: string): provider is AgentCli {
  return provider === 'claude' || provider === 'codex'
}

export const FORK_NOTICE: Record<AgentCli, string> = {
  claude: 'Forked from the whole session; Claude can’t fork at a single message.',
  codex: 'Forked from the whole session; Codex can’t fork at a single message.',
}

export function forkSession({ cwd, provider, sessionId, showTerminal = false }: { cwd: string; provider: string; sessionId: string; showTerminal?: boolean }): boolean {
  if (!canFork(provider)) return false
  const command = agentForkCommand(provider, sessionId)
  if (!command) return false
  openSplitInFolder(cwd, command)
  if (showTerminal) setSkin('terminal')
  pushNoticeToast(FORK_NOTICE[provider])
  return true
}
