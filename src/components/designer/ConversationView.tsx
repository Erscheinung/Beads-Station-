// A conversation turn, drawn quietly: your prompts are anchors, the agent's
// prose reads as plain text, and runs of tool calls fold into one line.
// Shared by Designer History and the saved screen of a restored pane.

import { MarkdownText } from '../RenderItems'
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

export function ToolGroup({ tools }: { tools: ToolBlock[] }) {
  if (tools.length === 1) return <details style={styles.tool} data-testid="tool-group">
    <summary style={styles.toolSummary}><strong>{tools[0].name}</strong> <span style={styles.toolArg}>{tools[0].summary}</span></summary>
    {tools[0].result && <pre style={styles.toolResult}>{tools[0].result}</pre>}
  </details>
  const names = [...new Set(tools.map(tool => tool.name))]
  const label = <><strong>{tools.length} tool calls</strong> <span style={styles.toolArg}>{names.slice(0, 3).join(', ')}{names.length > 3 ? '…' : ''}</span></>
  return <details style={styles.tool} data-testid="tool-group">
    <summary style={styles.toolSummary}>{label}</summary>
    <ul style={styles.toolList}>
      {tools.map((tool, index) => <li key={index}>
        <details>
          <summary style={styles.toolSummary}><strong>{tool.name}</strong> <span style={styles.toolArg}>{tool.summary}</span></summary>
          {tool.result && <pre style={styles.toolResult}>{tool.result}</pre>}
        </details>
      </li>)}
    </ul>
  </details>
}

export function TurnView({ turn, pinned, onPin }: { turn: TranscriptTurn; pinned?: boolean; onPin?: () => void }) {
  const prose = turnProse(turn)
  const user = turn.role === 'user'
  return <article style={{ ...styles.turn, ...(user ? styles.userTurn : null) }} data-role={turn.role}>
    <div style={styles.turnHead}>
      <span style={styles.role}>{user ? 'You' : 'Agent'}</span>
      {turn.thinking > 0 && <span style={styles.meta}>reasoned ×{turn.thinking}</span>}
      {prose && onPin && <button style={styles.link} onClick={onPin} aria-label="Pin this to the Shelf">{pinned ? 'Pinned' : 'Pin to Shelf'}</button>}
    </div>
    {groupBlocks(turn.blocks).map((group, index) => group.kind === 'text'
      ? (user ? <p key={index} style={styles.userText}>{group.text}</p> : <MarkdownText key={index} text={group.text} />)
      : <ToolGroup key={index} tools={group.tools} />)}
    {turn.files.length > 0 && <p style={styles.files}>Changed: {turn.files.map(file => <code key={file} style={styles.file}>{file.split('/').slice(-2).join('/')}</code>)}</p>}
  </article>
}

const styles: Record<string, React.CSSProperties> = {
  turn: { padding: '6px 2px 6px 12px', borderLeft: '2px solid transparent', fontSize: 13, lineHeight: 1.6, flexShrink: 0, minWidth: 0, overflowWrap: 'anywhere' },
  userTurn: { borderLeftColor: 'var(--bs-orange)', background: 'var(--bs-bg-dark)', borderRadius: '0 8px 8px 0', padding: '8px 12px' },
  turnHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 },
  role: { fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--bs-fg-muted)', fontWeight: 600 },
  meta: { fontSize: 12, color: 'var(--bs-fg-muted)' },
  userText: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  tool: { margin: '4px 0', fontSize: 12 },
  toolList: { listStyle: 'none', margin: '4px 0 0', padding: '0 0 0 12px' },
  toolSummary: { cursor: 'pointer', color: 'var(--bs-fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  toolArg: { fontFamily: 'var(--du-font-mono, ui-monospace, Menlo, monospace)' },
  toolResult: { margin: '4px 0 0', padding: 8, maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, background: 'var(--bs-bg-dark)', borderRadius: 6 },
  link: { marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--bs-fg-muted)', cursor: 'pointer', fontSize: 12 },
  files: { margin: '6px 0 0', fontSize: 12, color: 'var(--bs-fg-muted)', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' },
  file: { padding: '1px 6px', borderRadius: 4, background: 'var(--bs-bg-dark)', fontSize: 11 },
}
