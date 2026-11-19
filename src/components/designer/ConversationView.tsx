// A conversation turn drawn like the Claude Code / Codex chat: ">" prompts,
// markdown answers, and tool calls folded to one line each.
// Shared by Designer History and the saved screen of a restored pane.

import { MarkdownText } from '../RenderItems'
import { highlightSegments } from '../../lib/find'
import { turnProse, type TranscriptBlock, type TranscriptTurn } from './transcripts'

type ToolBlock = Extract<TranscriptBlock, { kind: 'tool' }>
type Group = { kind: 'text'; text: string } | { kind: 'tools'; tools: ToolBlock[] }

/** Consecutive tool calls become one group, like the CLIs' "Ran 3 commands". */
export function groupBlocks(blocks: TranscriptBlock[]): Group[] {
  const groups: Group[] = []
  for (const block of blocks) {
    if (block.kind === 'text') { groups.push(block); continue }
    const last = groups[groups.length - 1]
    if (last?.kind === 'tools') last.tools.push(block)
    else groups.push({ kind: 'tools', tools: [block] })
  }
  return groups
}

/** Text with the search words wrapped in <mark>. Built from text nodes, so nothing in it is read as markup. */
export function Highlighted({ text, words }: { text: string; words?: string[] }) {
  if (!words?.length) return <>{text}</>
  return <>{highlightSegments(text, words).map((segment, index) => segment.match ? <mark key={index} className="bs-find-mark">{segment.text}</mark> : segment.text)}</>
}

/** A tool result that is a unified diff gets coloured lines; anything else stays plain. */
export function looksLikeDiff(text: string): boolean {
  return /^@@ .* @@/m.test(text) || (/^--- /m.test(text) && /^\+\+\+ /m.test(text)) || /^diff --git /m.test(text)
}

export function ResultBody({ text }: { text: string }) {
  if (!looksLikeDiff(text)) return <pre className="bs-chat-result">{text}</pre>
  return <pre className="bs-chat-result" data-testid="tool-diff">{text.split('\n').map((line, index) => {
    const kind = line.startsWith('@@') ? 'bs-diff-hunk'
      : line.startsWith('+') && !line.startsWith('+++') ? 'bs-diff-add'
      : line.startsWith('-') && !line.startsWith('---') ? 'bs-diff-del' : null
    return kind ? <span key={index} className={kind}>{line}</span> : <span key={index}>{line}{'\n'}</span>
  })}</pre>
}

/** One tool call: a single collapsed line, "Name target", that opens to the result. */
function ToolLine({ tool, words }: { tool: ToolBlock; words?: string[] }) {
  return <details className="bs-chat-tool" data-testid="tool-group">
    <summary><span className="bs-chat-tool-name">{tool.name}</span> <Highlighted text={tool.summary} words={words} /></summary>
    {tool.result && <ResultBody text={tool.result} />}
  </details>
}

/** Up to three calls show as their own lines; a longer run folds behind one line like "Ran 7 commands". */
export function ToolGroup({ tools, words }: { tools: ToolBlock[]; words?: string[] }) {
  if (tools.length <= 3) return <>{tools.map((tool, index) => <ToolLine key={index} tool={tool} words={words} />)}</>
  const names = [...new Set(tools.map(tool => tool.name))]
  return <details className="bs-chat-tool" data-testid="tool-group">
    <summary><span className="bs-chat-tool-name">{tools.length} tool calls</span> {names.slice(0, 3).join(', ')}{names.length > 3 ? '…' : ''}</summary>
    <div style={{ paddingLeft: 12 }}>{tools.map((tool, index) => <ToolLine key={index} tool={tool} words={words} />)}</div>
  </details>
}

/** "14:05" today, "Mon 14:05" this week, a date before that. Null for a missing or unreadable stamp. */
export function turnTime(at: string | null, now = Date.now()): string | null {
  if (!at) return null
  const date = new Date(at)
  const ms = date.getTime()
  if (Number.isNaN(ms)) return null
  const clock = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const age = now - ms
  if (age < 86_400_000 && new Date(now).getDate() === date.getDate()) return clock
  if (age < 6 * 86_400_000) return `${date.toLocaleDateString([], { weekday: 'short' })} ${clock}`
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/**
 * One turn, drawn like the CLIs' own chat. Your prompts sit on a tinted line
 * behind a ">" gutter, the agent's answer is markdown behind a "●", tool calls
 * are one-line folds, reasoning is a dim line, and file names open in the
 * editor when `onOpenFile` is given.
 */
export function TurnView({ turn, pinned, onPin, onFork, onOpenFile, agentLabel = 'Agent', highlight }: {
  turn: TranscriptTurn
  pinned?: boolean
  onPin?: () => void
  /** Offered on your own prompts: fork the session into a new split. */
  onFork?: () => void
  onOpenFile?: (path: string) => void
  agentLabel?: string
  /** Search words to mark in the text. */
  highlight?: string[]
}) {
  const prose = turnProse(turn)
  const user = turn.role === 'user'
  const time = turnTime(turn.at)
  return <article className={`bs-chat-turn ${user ? 'bs-chat-user' : 'bs-chat-assistant'}`} data-role={turn.role} aria-label={user ? 'You' : agentLabel}>
    <span className="bs-chat-gutter" aria-hidden>{user ? '>' : '\u25CF'}</span>
    <div className="bs-chat-body">
      {(time || (prose && onPin) || (user && onFork)) && <div className="bs-chat-who">
        <span>{user ? 'You' : agentLabel}</span>
        {time && <span>{time}</span>}
        {user && onFork && <button style={{ ...styles.link, marginLeft: prose && onPin ? 8 : 'auto' }} onClick={onFork} aria-label="Fork here" title="Fork the whole session into a new split (the CLIs cannot fork at one message)">Fork here</button>}
        {prose && onPin && <button style={styles.link} onClick={onPin} aria-label="Pin this answer" title="Keep this in Pinned, to type into a prompt later">{pinned ? 'Pinned' : 'Pin'}</button>}
      </div>}
      {turn.thinking > 0 && <div className="bs-chat-thinking">Thinking{turn.thinking > 1 ? ` \u00D7${turn.thinking}` : ''}</div>}
      {groupBlocks(turn.blocks).map((group, index) => group.kind === 'text'
        ? (user ? <p key={index} style={styles.userText}><Highlighted text={group.text} words={highlight} /></p> : <MarkdownText key={index} text={group.text} highlight={highlight} />)
        : <ToolGroup key={index} tools={group.tools} words={highlight} />)}
      {turn.files.length > 0 && <p style={styles.files}>Changed: {turn.files.map(file => onOpenFile
        ? <button key={file} style={{ ...styles.file, ...styles.fileButton }} title={`Open ${file.split('/').pop()} in your editor`} onClick={() => onOpenFile(file)}>{file.split('/').slice(-2).join('/')}</button>
        : <code key={file} style={styles.file}>{file.split('/').slice(-2).join('/')}</code>)}</p>}
    </div>
  </article>
}

const styles: Record<string, React.CSSProperties> = {
  fileButton: { border: '1px solid var(--bs-border)', cursor: 'pointer', color: 'inherit', fontFamily: 'inherit' },
  userText: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  link: { border: 'none', background: 'transparent', color: 'var(--bs-fg-muted)', cursor: 'pointer', fontSize: 11, padding: 0, marginLeft: 'auto' },
  files: { margin: '4px 0 0', fontSize: 11.5, color: 'var(--bs-fg-muted)', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' },
  file: { padding: '1px 6px', borderRadius: 4, background: 'var(--bs-bg-dark)', fontSize: 11 },
}
