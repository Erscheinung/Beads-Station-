// RV3-A (Code-d3p) — React renderers for the RenderItem tree produced by
// buildRenderItems. Everything here is presentational; the pairing/nesting
// logic lives in ../lib/renderItems.ts (pure + unit-tested).
//
// - MarkdownText : sanitized markdown (rehype-sanitize, defense-in-depth) +
//                  syntax-highlighted fences (rehype-highlight).
// - ToolPair     : collapsible tool_use ↔ tool_result unit.
// - DiffPair     : Edit/Write/MultiEdit rendered as a unified line diff.
// - TaskChain    : recursive, collapsible subagent chain.
//
// Collapse state is component-local useState (recon warning: do NOT reuse
// ToolDrawer's single sessionStorage key — the keyspace would explode).
// Glyphs are @vscode/codicons (already a dep) so the emoji-audit gate stays
// green — no unicode emoji anywhere.

import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { PluggableList } from 'unified';
import rehypeHighlight from 'rehype-highlight';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { diffLines } from 'diff';

import type { RenderItem, ToolResultBlock, ToolUseBlock } from '../lib/renderItems';
import { resultToText } from '../lib/renderItems';

// RV3.7 (Code-dz5) — R8 §5/§8 mandated defense-in-depth sanitization. The
// default react-markdown@10 pipeline renders no raw HTML, but that is an
// implicit property, not the specified defense — if rehype-raw is ever added,
// raw <script>/<img onerror> in an assistant message would execute. Run
// rehype-sanitize LAST, with a schema that additionally permits `className` on
// code/pre/span so rehype-highlight's hljs token classes survive the sanitizer
// (the default schema strips them — the R8 "load-bearing schema" warning).
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), 'className'],
    pre: [...(defaultSchema.attributes?.pre ?? []), 'className'],
    span: [...(defaultSchema.attributes?.span ?? []), 'className'],
  },
};

const REHYPE_PLUGINS: PluggableList = [rehypeHighlight, [rehypeSanitize, SANITIZE_SCHEMA]];

function Chevron({ open }: { open: boolean }) {
  return (
    <span
      className={`codicon codicon-chevron-${open ? 'down' : 'right'}`}
      style={{ fontSize: 12, opacity: 0.7, flexShrink: 0 }}
      aria-hidden
    />
  );
}

function inputSummary(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'object') {
    const o = input as Record<string, unknown>;
    // Prefer the human-meaningful field per common tool.
    const pick =
      o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.description ?? o.prompt ?? o.url;
    if (typeof pick === 'string') return pick.length > 120 ? pick.slice(0, 120) + '…' : pick;
  }
  try {
    const s = JSON.stringify(input);
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
  } catch {
    return '';
  }
}

export function MarkdownText({ text }: { text: string }) {
  return (
    <div className="bs-md">
      <ReactMarkdown rehypePlugins={REHYPE_PLUGINS}>{text}</ReactMarkdown>
    </div>
  );
}

function ToolHeader({
  tool,
  result,
  open,
  onToggle,
  label,
}: {
  tool: ToolUseBlock;
  result: ToolResultBlock | null;
  open: boolean;
  onToggle: () => void;
  label?: string;
}) {
  const errored = result?.is_error === true;
  const dot = result == null ? 'var(--bs-yellow)' : errored ? 'var(--bs-red)' : 'var(--bs-green)';
  return (
    <button type="button" className="bs-tool-head" onClick={onToggle} aria-expanded={open}>
      <Chevron open={open} />
      <span
        style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0 }}
        aria-hidden
      />
      <span className="bs-tool-name">{label ?? tool.name}</span>
      <span className="bs-tool-arg">{inputSummary(tool.input)}</span>
      {result == null && <span className="bs-tool-pending">running…</span>}
    </button>
  );
}

export function ToolPair({ tool, result }: { tool: ToolUseBlock; result: ToolResultBlock | null }) {
  const [open, setOpen] = useState(false);
  const resultText = resultToText(result);
  return (
    <div className="bs-tool">
      <ToolHeader tool={tool} result={result} open={open} onToggle={() => setOpen((o) => !o)} />
      {open && (
        <div className="bs-tool-body">
          {tool.input != null && (
            <pre className="bs-tool-input">{JSON.stringify(tool.input, null, 2)}</pre>
          )}
          {result != null && (
            <pre className={`bs-tool-result${result.is_error ? ' bs-tool-result-err' : ''}`}>
              {resultText || '(no output)'}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function DiffPair({
  tool,
  result,
  filePath,
  before,
  after,
}: {
  tool: ToolUseBlock;
  result: ToolResultBlock | null;
  filePath: string;
  before: string;
  after: string;
}) {
  const [open, setOpen] = useState(true); // diffs are the payoff — default open
  // RV3.7 (Code-sc4) — R9 §5 requires a unified↔side-by-side view-mode toggle.
  const [mode, setMode] = useState<'unified' | 'split'>('unified');
  const parts = useMemo(() => diffLines(before, after), [before, after]);

  // RV3.7 (Code-sc4) — R9 §5 header line-count delta (+N −M), derived from the
  // diff parts (count lines in added/removed hunks).
  const { added, removed } = useMemo(() => {
    let a = 0;
    let r = 0;
    for (const p of parts) {
      if (p.added || p.removed) {
        const n = p.value.replace(/\n$/, '').split('\n').length;
        if (p.added) a += n;
        else r += n;
      }
    }
    return { added: a, removed: r };
  }, [parts]);

  const label = `${tool.name} · ${filePath.split('/').pop() || filePath}`;
  return (
    <div className="bs-tool bs-diff">
      <ToolHeader tool={tool} result={result} open={open} onToggle={() => setOpen((o) => !o)} label={label} />
      {open && (
        <>
          {/* Diff sub-header: line-count delta + view-mode toggle (R9 §5). */}
          <div className="bs-diff-subhead">
            <span className="bs-diff-delta">
              <span className="bs-diff-delta-add">{`+${added}`}</span>
              {' '}
              <span className="bs-diff-delta-del">{`-${removed}`}</span>
            </span>
            <button
              type="button"
              className="bs-diff-toggle"
              onClick={() => setMode((m) => (m === 'unified' ? 'split' : 'unified'))}
              title="Toggle unified / side-by-side"
            >
              {mode === 'unified' ? 'side-by-side' : 'unified'}
            </button>
          </div>
          {mode === 'unified' ? (
            <div className="bs-diff-body">
              {parts.map((p, i) => {
                const cls = p.added ? 'bs-diff-add' : p.removed ? 'bs-diff-del' : 'bs-diff-ctx';
                const mark = p.added ? '+' : p.removed ? '-' : ' ';
                // Split into lines so each gets its own gutter mark.
                const lines = p.value.replace(/\n$/, '').split('\n');
                return lines.map((ln, j) => (
                  <div key={`${i}-${j}`} className={`bs-diff-line ${cls}`}>
                    <span className="bs-diff-gutter" aria-hidden>{mark}</span>
                    <span className="bs-diff-text">{ln}</span>
                  </div>
                ));
              })}
              {result?.is_error && (
                <pre className="bs-tool-result bs-tool-result-err">{resultToText(result)}</pre>
              )}
            </div>
          ) : (
            <div className="bs-diff-split">
              <DiffColumn parts={parts} side="before" />
              <DiffColumn parts={parts} side="after" />
            </div>
          )}
        </>
      )}
    </div>
  );
}

// RV3.7 (Code-sc4) — side-by-side column. 'before' shows context + removed
// lines; 'after' shows context + added lines. Added/removed rows on the
// opposite side render as empty placeholders so the two columns stay aligned.
function DiffColumn({ parts, side }: { parts: ReturnType<typeof diffLines>; side: 'before' | 'after' }) {
  const rows: { cls: string; text: string; mark: string }[] = [];
  for (const p of parts) {
    const lines = p.value.replace(/\n$/, '').split('\n');
    if (p.added) {
      for (const ln of lines) {
        if (side === 'after') rows.push({ cls: 'bs-diff-add', text: ln, mark: '+' });
        else rows.push({ cls: 'bs-diff-empty', text: '', mark: '' });
      }
    } else if (p.removed) {
      for (const ln of lines) {
        if (side === 'before') rows.push({ cls: 'bs-diff-del', text: ln, mark: '-' });
        else rows.push({ cls: 'bs-diff-empty', text: '', mark: '' });
      }
    } else {
      for (const ln of lines) rows.push({ cls: 'bs-diff-ctx', text: ln, mark: ' ' });
    }
  }
  return (
    <div className="bs-diff-col">
      {rows.map((r, i) => (
        <div key={i} className={`bs-diff-line ${r.cls}`}>
          <span className="bs-diff-gutter" aria-hidden>{r.mark}</span>
          <span className="bs-diff-text">{r.text}</span>
        </div>
      ))}
    </div>
  );
}

export function TaskChain({
  tool,
  result,
  items,
}: {
  tool: ToolUseBlock;
  result: ToolResultBlock | null;
  items: RenderItem[];
}) {
  const [open, setOpen] = useState(false); // subagent chains collapse by default
  const label = `Task · ${inputSummary(tool.input) || 'subagent'}`;
  return (
    <div className="bs-tool bs-task">
      <ToolHeader tool={tool} result={result} open={open} onToggle={() => setOpen((o) => !o)} label={label} />
      {open && (
        <div className="bs-task-body">
          {items.length === 0 ? (
            <div className="bs-task-empty">(no subagent output yet)</div>
          ) : (
            <RenderItemList items={items} />
          )}
          {result != null && (
            <pre className={`bs-tool-result${result.is_error ? ' bs-tool-result-err' : ''}`}>
              {resultToText(result) || '(subagent returned no text)'}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// Dispatch one item to its renderer. Recursive via TaskChain -> RenderItemList.
export function RenderItemView({ item }: { item: RenderItem }) {
  switch (item.kind) {
    case 'markdown':
      return <MarkdownText text={item.text} />;
    case 'toolpair':
      return <ToolPair tool={item.tool} result={item.result} />;
    case 'diffpair':
      return (
        <DiffPair
          tool={item.tool}
          result={item.result}
          filePath={item.filePath}
          before={item.before}
          after={item.after}
        />
      );
    case 'taskchain':
      return <TaskChain tool={item.tool} result={item.result} items={item.children} />;
    case 'localuser':
      return <div className="bs-chat-you">&gt; {item.text}</div>;
    case 'reminder':
      return <div className="bs-system-reminder">{item.text}</div>;
    case 'stderr':
      return <pre className="bs-chat-line bs-chat-stderr">[stderr] {item.text}</pre>;
    case 'raw':
      return <pre className="bs-chat-line bs-chat-raw">[raw] {item.text}</pre>;
    case 'system':
      return <pre className="bs-chat-line bs-chat-dim">[system] {item.text}</pre>;
    case 'result':
      return <pre className="bs-chat-line bs-chat-dim">[result] {item.text}</pre>;
    case 'text':
      return <pre className="bs-chat-line">{item.text}</pre>;
    case 'unknown':
    default:
      return <pre className="bs-chat-line bs-chat-dim">{item.text}</pre>;
  }
}

export function RenderItemList({ items }: { items: RenderItem[] }) {
  return (
    <>
      {items.map((item) => (
        <RenderItemView key={item.key} item={item} />
      ))}
    </>
  );
}
