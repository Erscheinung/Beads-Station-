// RV3-A (Code-d3p) — the pairing pre-pass that turns the flat, per-frame
// stream-json list into a tree of render items:
//
//   - tool_use  ↔  tool_result   paired into ONE ToolPair (collapsible)
//   - Task tool_use              gathers its subagent frames (matched by
//                                parent_tool_use_id) into a recursive TaskChain
//   - assistant text             -> Markdown item
//   - system / result / _kind    -> passthrough items
//
// It is a PURE function over frames[] — no React, no mutation. ClaudeChat
// runs it inside a useMemo keyed on `frames`, so R2's bounded 500-cap +
// appendFrame path (the store) stays the only writer and getSnapshot stays
// cached. Frame eviction can split a pair (tool_use gone, tool_result left,
// or vice-versa); the pass degrades gracefully — an orphan tool_result and an
// unresolved tool_use each render on their own rather than throwing.
//
// Frame shapes (verbatim from the Claude CLI; the BE passes them through
// unchanged — see claude.rs stdout reader):
//   assistant : { type:'assistant', parent_tool_use_id, message:{ content:[
//                   { type:'text', text } | { type:'tool_use', id, name, input } ] } }
//   tool_result: { type:'user', message:{ content:[
//                   { type:'tool_result', tool_use_id, content, is_error? } ] } }
//   system    : { type:'system', subtype }
//   result    : { type:'result', subtype, total_cost_usd, usage }
//   synthetic : { _local, role, text } | { _kind:'stderr'|'raw'|'system-reminder', ... }

export interface ToolUseBlock {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}

// Discriminated render items consumed by RenderItems.tsx.
export type RenderItem =
  | { kind: 'markdown'; key: string; text: string }
  | { kind: 'text'; key: string; text: string } // non-assistant plain lines (styled)
  | { kind: 'toolpair'; key: string; tool: ToolUseBlock; result: ToolResultBlock | null }
  | {
      kind: 'diffpair';
      key: string;
      tool: ToolUseBlock;
      result: ToolResultBlock | null;
      filePath: string;
      before: string;
      after: string;
    }
  | {
      kind: 'taskchain';
      key: string;
      tool: ToolUseBlock;
      result: ToolResultBlock | null;
      children: RenderItem[];
    }
  | { kind: 'system'; key: string; text: string }
  | { kind: 'result'; key: string; text: string }
  | { kind: 'stderr'; key: string; text: string }
  | { kind: 'raw'; key: string; text: string }
  | { kind: 'reminder'; key: string; text: string }
  | { kind: 'localuser'; key: string; text: string }
  | { kind: 'unknown'; key: string; text: string };

const DIFF_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function contentBlocks(frame: any): any[] {
  const c = frame?.message?.content;
  return Array.isArray(c) ? c : [];
}

function toolUsesIn(frame: any): ToolUseBlock[] {
  return contentBlocks(frame)
    .filter((p) => p?.type === 'tool_use' && typeof p?.id === 'string')
    .map((p) => ({ id: p.id, name: String(p.name ?? 'unknown'), input: p.input ?? null }));
}

function toolResultsIn(frame: any): ToolResultBlock[] {
  return contentBlocks(frame)
    .filter((p) => p?.type === 'tool_result' && typeof p?.tool_use_id === 'string')
    .map((p) => ({ tool_use_id: p.tool_use_id, content: p.content ?? null, is_error: !!p.is_error }));
}

function assistantText(frame: any): string {
  return contentBlocks(frame)
    .filter((p) => p?.type === 'text' && typeof p?.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

// Coerce a tool_result content payload to a display string. The CLI sends
// either a string or an array of {type:'text',text} blocks.
export function resultToText(result: ToolResultBlock | null): string {
  if (!result) return '';
  const c = result.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? String(b.text ?? '') : JSON.stringify(b)))
      .join('\n');
  }
  return c == null ? '' : JSON.stringify(c, null, 2);
}

// Pull before/after text out of an Edit/Write/MultiEdit tool_use input so the
// UI can render a diff. Returns null when the input isn't diff-shaped (then it
// falls back to a plain ToolPair). MultiEdit concatenates its edits.
export function diffFromToolInput(
  name: string,
  input: any,
): { filePath: string; before: string; after: string } | null {
  if (!input || typeof input !== 'object') return null;
  const filePath = String(input.file_path ?? input.path ?? input.notebook_path ?? '');
  if (name === 'Write') {
    // Whole-file write: before is unknown here (no read), so show as all-added.
    return { filePath, before: '', after: String(input.content ?? '') };
  }
  if (name === 'Edit') {
    if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') return null;
    return { filePath, before: input.old_string, after: input.new_string };
  }
  if (name === 'MultiEdit' || name === 'NotebookEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    if (edits.length === 0) return null;
    const before = edits.map((e: any) => String(e?.old_string ?? '')).join('\n');
    const after = edits.map((e: any) => String(e?.new_string ?? '')).join('\n');
    return { filePath, before, after };
  }
  return null;
}

/**
 * Build the ordered render-item tree from the flat frames array.
 *
 * @param frames        the bounded (≤500) frames[] from ClaudeChat
 * @param isApprovalPending (id) => boolean — a tool_use whose approval is
 *   still pending is NOT rendered here (ClaudeChat renders it as an
 *   ApprovalCard instead). Once resolved / once a tool_result arrives, it
 *   becomes a normal collapsible pair. Passing () => false renders everything.
 */
export function buildRenderItems(
  frames: any[],
  isApprovalPending: (toolUseId: string) => boolean = () => false,
): RenderItem[] {
  // ---- Global indexes (built ONCE over the full flat list) ----------------
  // tool_result by tool_use_id — a tool_result frame carries NO
  // parent_tool_use_id, so it's matched purely by id and can live at any depth.
  const resultById = new Map<string, ToolResultBlock>();
  for (const f of frames) {
    if (f?.type === 'user') {
      for (const r of toolResultsIn(f)) resultById.set(r.tool_use_id, r);
    }
  }

  // Frames grouped by the scope that owns them: parent_tool_use_id, or the
  // sentinel ROOT for top-level frames (null/absent parent). A Task's nested
  // body is exactly the frames whose parent === that Task's tool_use id.
  const ROOT = Symbol('root');
  const framesByScope = new Map<string | symbol, any[]>();
  for (const f of frames) {
    const parent = f?.parent_tool_use_id;
    const scope: string | symbol = typeof parent === 'string' && parent.length > 0 ? parent : ROOT;
    const arr = framesByScope.get(scope) ?? [];
    arr.push(f);
    framesByScope.set(scope, arr);
  }

  // tool_use ids we've paired with a tool_result — so the standalone result
  // frame isn't ALSO rendered raw.
  const pairedResultToolIds = new Set<string>();

  let seq = 0;
  const nextKey = (hint: string) => `${hint}-${seq++}`;

  // Recursively render one scope (ROOT, or a Task's tool_use id). Renders ONLY
  // the frames directly owned by this scope; a nested Task recurses into its
  // own id. Guard against a (malformed) parent cycle with a visited set.
  const renderScope = (scope: string | symbol, visited: Set<string>): RenderItem[] => {
    const scopeFrames = framesByScope.get(scope) ?? [];
    const items: RenderItem[] = [];

    const emitToolUse = (tu: ToolUseBlock): RenderItem => {
      const result = resultById.get(tu.id) ?? null;
      if (result) pairedResultToolIds.add(tu.id);

      if (tu.name === 'Task') {
        // Recurse into the frames whose parent === this Task's id.
        const children =
          visited.has(tu.id) ? [] : renderScope(tu.id, new Set(visited).add(tu.id));
        return { kind: 'taskchain', key: nextKey('task'), tool: tu, result, children };
      }

      if (DIFF_TOOLS.has(tu.name)) {
        const d = diffFromToolInput(tu.name, tu.input);
        if (d) {
          return {
            kind: 'diffpair',
            key: nextKey('diff'),
            tool: tu,
            result,
            filePath: d.filePath,
            before: d.before,
            after: d.after,
          };
        }
      }
      return { kind: 'toolpair', key: nextKey('tool'), tool: tu, result };
    };

    for (const f of scopeFrames) {
      // Synthetic FE frames.
      if (f?._kind === 'system-reminder') {
        items.push({ kind: 'reminder', key: nextKey('rem'), text: String(f.text ?? '') });
        continue;
      }
      if (f?._kind === 'stderr') {
        items.push({ kind: 'stderr', key: nextKey('err'), text: String(f.line ?? '') });
        continue;
      }
      if (f?._kind === 'raw') {
        items.push({ kind: 'raw', key: nextKey('raw'), text: String(f.line ?? '') });
        continue;
      }
      if (f?._local) {
        items.push({ kind: 'localuser', key: nextKey('you'), text: String(f.text ?? '') });
        continue;
      }

      if (f?.type === 'assistant') {
        const text = assistantText(f);
        if (text) items.push({ kind: 'markdown', key: nextKey('md'), text });
        for (const tu of toolUsesIn(f)) {
          if (isApprovalPending(tu.id)) continue; // ApprovalCard owns it for now
          items.push(emitToolUse(tu));
        }
        continue;
      }

      if (f?.type === 'user') {
        // tool_result carrier. Defer: emit only the orphans (whose tool_use is
        // absent from the WHOLE list) in a second sweep after all tool_uses
        // have had a chance to claim their result. We stash the frame and
        // resolve orphans at the end of this scope.
        continue;
      }

      if (f?.type === 'system') {
        items.push({ kind: 'system', key: nextKey('sys'), text: String(f?.subtype ?? '') });
        continue;
      }
      if (f?.type === 'result') {
        items.push({ kind: 'result', key: nextKey('res'), text: String(f?.subtype ?? '') });
        continue;
      }

      // Streaming partials from --include-partial-messages: the CLI emits a
      // stream_event frame per delta (message_start/content_block_delta/
      // message_delta/content_block_stop, etc.). The final `assistant` frame
      // already carries the complete text, and claudeUsage reads usage only
      // from `assistant`/`result` — so these deltas are pure render noise.
      // Drop them instead of falling through to the raw-JSON `unknown` case.
      if (f?.type === 'stream_event') {
        continue;
      }

      items.push({ kind: 'unknown', key: nextKey('unk'), text: JSON.stringify(f).slice(0, 400) });
    }

    // Second sweep: surface tool_results in THIS scope whose tool_use never
    // paired (eviction split the pair — the tool_use is gone). Runs after the
    // scope's tool_uses have claimed their ids.
    for (const f of scopeFrames) {
      if (f?.type !== 'user') continue;
      for (const r of toolResultsIn(f)) {
        if (pairedResultToolIds.has(r.tool_use_id)) continue;
        pairedResultToolIds.add(r.tool_use_id);
        items.push({
          kind: 'toolpair',
          key: nextKey('orphan'),
          tool: { id: r.tool_use_id, name: '(result — tool_use evicted)', input: null },
          result: r,
        });
      }
    }

    return items;
  };

  return renderScope(ROOT, new Set());
}
