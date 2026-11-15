// Small neutral marks for the agent providers (not the vendors' logos): a burst,
// a prompt, a spark. Shared by the top bar launchers and the Designer's agent
// and timeline views so one provider looks the same everywhere.

import type { ReactNode } from 'react'

export type ProviderMarkId = 'claude' | 'codex' | 'gemini' | 'qwen' | 'conductor'

const MARKS: Record<ProviderMarkId, ReactNode> = {
  claude: <path d="M8 2v12M2 8h12M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />,
  codex: <><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M5.4 6l2 2-2 2M8.6 10.2h2.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></>,
  gemini: <path d="M8 1.5c.6 3.6 2.9 5.9 6.5 6.5-3.6.6-5.9 2.9-6.5 6.5-.6-3.6-2.9-5.9-6.5-6.5 3.6-.6 5.9-2.9 6.5-6.5z" fill="currentColor" />,
  // A ring with a tail: a local model.
  qwen: <><circle cx="7.4" cy="7.4" r="4.8" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.6 10.6L14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  // Three stacked bars: the app's own conductor, not a provider CLI.
  conductor: <path d="M2.5 4h11M2.5 8h7M2.5 12h9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />,
}

export const PROVIDER_NAME: Record<ProviderMarkId, string> = {
  claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', qwen: 'Qwen', conductor: 'Conductor',
}

export function ProviderMarkPath({ id }: { id: ProviderMarkId }) { return <>{MARKS[id]}</> }

export function ProviderMark({ id, size = 14, className }: { id: ProviderMarkId; size?: number; className?: string }) {
  return <svg className={className} viewBox="0 0 16 16" width={size} height={size} role="img" aria-label={PROVIDER_NAME[id]}>{MARKS[id]}</svg>
}
