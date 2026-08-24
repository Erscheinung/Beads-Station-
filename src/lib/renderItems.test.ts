import { describe, it, expect } from 'vitest';
import { buildRenderItems, diffFromToolInput, resultToText } from './renderItems';

// Minimal frame factories mirroring the Claude CLI stream-json shapes.
const asstText = (text: string, parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const asstTool = (id: string, name: string, input: any, parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (toolUseId: string, content: any, isError = false) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
});

describe('buildRenderItems — pairing', () => {
  it('pairs a tool_use with its tool_result into one toolpair', () => {
    const items = buildRenderItems([asstTool('t1', 'Bash', { command: 'ls' }), toolResult('t1', 'a.txt')]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('toolpair');
    const it0 = items[0] as any;
    expect(it0.tool.id).toBe('t1');
    expect(it0.result.tool_use_id).toBe('t1');
    expect(resultToText(it0.result)).toBe('a.txt');
  });

  it('does NOT also render the standalone tool_result frame', () => {
    const items = buildRenderItems([asstTool('t1', 'Bash', {}), toolResult('t1', 'ok')]);
    // Exactly one item — the result frame must be consumed, not rendered raw.
    expect(items.filter((i) => i.kind === 'unknown')).toHaveLength(0);
    expect(items).toHaveLength(1);
  });

  it('renders an unresolved tool_use as a pair with null result (pending tool)', () => {
    const items = buildRenderItems([asstTool('t1', 'Bash', {})]);
    expect(items).toHaveLength(1);
    expect((items[0] as any).result).toBeNull();
  });

  it('surfaces an orphan tool_result when its tool_use was evicted', () => {
    const items = buildRenderItems([toolResult('gone', 'late output')]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('toolpair');
    expect((items[0] as any).tool.name).toMatch(/evicted/);
    expect(resultToText((items[0] as any).result)).toBe('late output');
  });

  it('handles multiple tool_use blocks in one assistant frame', () => {
    const multi = {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_use', id: 'a', name: 'Bash', input: {} },
          { type: 'tool_use', id: 'b', name: 'Grep', input: {} },
        ],
      },
    };
    const items = buildRenderItems([multi, toolResult('a', '1'), toolResult('b', '2')]);
    expect(items).toHaveLength(2);
    expect(items.map((i) => (i as any).tool.id)).toEqual(['a', 'b']);
  });
});

describe('buildRenderItems — diffs', () => {
  it('renders an Edit as a diffpair with before/after', () => {
    const items = buildRenderItems([
      asstTool('e1', 'Edit', { file_path: '/x.ts', old_string: 'foo', new_string: 'bar' }),
      toolResult('e1', 'ok'),
    ]);
    expect(items[0].kind).toBe('diffpair');
    const d = items[0] as any;
    expect(d.filePath).toBe('/x.ts');
    expect(d.before).toBe('foo');
    expect(d.after).toBe('bar');
  });

  it('renders a Write as all-added diff (empty before)', () => {
    const items = buildRenderItems([asstTool('w1', 'Write', { file_path: '/n.ts', content: 'hello' })]);
    expect(items[0].kind).toBe('diffpair');
    expect((items[0] as any).before).toBe('');
    expect((items[0] as any).after).toBe('hello');
  });

  it('falls back to toolpair when Edit input is not diff-shaped', () => {
    const items = buildRenderItems([asstTool('e1', 'Edit', { file_path: '/x.ts' })]);
    expect(items[0].kind).toBe('toolpair');
  });

  it('MultiEdit concatenates edits', () => {
    const d = diffFromToolInput('MultiEdit', {
      file_path: '/m.ts',
      edits: [
        { old_string: 'a', new_string: 'A' },
        { old_string: 'b', new_string: 'B' },
      ],
    });
    expect(d).not.toBeNull();
    expect(d!.before).toBe('a\nb');
    expect(d!.after).toBe('A\nB');
  });
});

describe('buildRenderItems — Task subagent chains', () => {
  it('nests child frames under their parent Task as a recursive chain', () => {
    const frames = [
      asstTool('task1', 'Task', { description: 'do thing' }),
      asstText('child working', 'task1'),
      asstTool('c1', 'Bash', { command: 'echo' }, 'task1'),
      toolResult('c1', 'echoed'), // child's tool_result — no parent field, matched by id
      toolResult('task1', 'subagent done'),
    ];
    const items = buildRenderItems(frames);
    // Top level: only the taskchain (children consumed).
    const chains = items.filter((i) => i.kind === 'taskchain');
    expect(chains).toHaveLength(1);
    const chain = chains[0] as any;
    expect(chain.tool.id).toBe('task1');
    expect(resultToText(chain.result)).toBe('subagent done');
    // Child text + child tool render INSIDE the chain.
    expect(chain.children.some((c: any) => c.kind === 'markdown' && c.text === 'child working')).toBe(true);
    expect(chain.children.some((c: any) => c.kind === 'toolpair' && c.tool.id === 'c1')).toBe(true);
    // Child frames must NOT leak to top level.
    expect(items.some((i) => (i as any).tool?.id === 'c1')).toBe(false);
  });
});

describe('buildRenderItems — approval gating & synthetic frames', () => {
  it('skips a tool_use whose approval is still pending (ApprovalCard owns it)', () => {
    const items = buildRenderItems([asstTool('p1', 'Bash', {})], (id) => id === 'p1');
    expect(items).toHaveLength(0);
  });

  it('passes through local user echo, stderr, raw, reminder, system, result', () => {
    const items = buildRenderItems([
      { _local: true, role: 'user', text: 'hi' },
      { _kind: 'stderr', line: 'boom' },
      { _kind: 'raw', line: 'weird' },
      { _kind: 'system-reminder', text: 'note' },
      { type: 'system', subtype: 'init' },
      { type: 'result', subtype: 'success' },
    ]);
    expect(items.map((i) => i.kind)).toEqual(['localuser', 'stderr', 'raw', 'reminder', 'system', 'result']);
  });

  it('drops streaming partial (stream_event) frames instead of rendering raw JSON', () => {
    // Code-6w0 follow-up: --include-partial-messages emits stream_event deltas
    // wrapping content_block_delta/message_delta/etc. The final assistant frame
    // carries the complete text; these must not fall through to `unknown`.
    const items = buildRenderItems([
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } },
      asstText('Hey. What do you need?'),
    ]);
    expect(items.filter((i) => i.kind === 'unknown')).toHaveLength(0);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('markdown');
    expect((items[0] as any).text).toBe('Hey. What do you need?');
  });
});
