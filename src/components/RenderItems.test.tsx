import { describe, it, expect } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { MarkdownText, DiffPair } from './RenderItems'
import type { ToolUseBlock } from '../lib/renderItems'

// ---------------------------------------------------------------------------
// RV3.7 render regressions for the R8/R9 gaps the audit confirmed:
//   Code-dz5 — rehype-sanitize must strip raw <script> from assistant markdown
//              (defense-in-depth; inert even if rehype-raw is later added).
//   Code-sc4 — DiffPair must show a +N −M line-count delta AND a unified↔
//              side-by-side view-mode toggle.
// ---------------------------------------------------------------------------

describe('MarkdownText — rehype-sanitize (Code-dz5)', () => {
  it('does not render a raw <script> element', () => {
    const { container } = render(
      <MarkdownText text={'hello\n\n<script>window.__pwned=1</script>\n\nbye'} />,
    )
    expect(container.querySelector('script')).toBeNull()
    // benign text still renders
    expect(container.textContent).toContain('hello')
  })

  it('preserves rehype-highlight class names on code (schema is load-bearing)', () => {
    const { container } = render(
      <MarkdownText text={'```js\nconst x = 1\n```'} />,
    )
    // rehype-highlight wraps tokens in <span class="hljs-..."> and marks the
    // <code> with a language class; the sanitizer schema must allow className
    // on code/pre/span or highlighting silently disappears.
    const code = container.querySelector('code')
    expect(code).not.toBeNull()
    expect(code?.className ?? '').toMatch(/hljs|language-/)
  })
})

describe('DiffPair — R9 header (Code-sc4)', () => {
  const tool: ToolUseBlock = { id: 't1', name: 'Edit', input: { file_path: '/x/a.ts' } }

  it('shows the +N −M line-count delta and a view-mode toggle', () => {
    const before = 'a\nb\nc\n'
    const after = 'a\nB\nc\nd\n' // 2 added (B, d), 1 removed (b)
    const { getByText, container } = render(
      <DiffPair tool={tool} result={null} filePath="/x/a.ts" before={before} after={after} />,
    )
    // delta present
    expect(getByText('+2')).toBeTruthy()
    expect(getByText('-1')).toBeTruthy()
    // toggle present (starts unified -> offers side-by-side)
    const toggle = container.querySelector('.bs-diff-toggle')
    expect(toggle).not.toBeNull()
    expect(toggle?.textContent).toBe('side-by-side')
  })

  it('toggle switches to the split (side-by-side) layout and back', () => {
    const { container } = render(
      <DiffPair tool={tool} result={null} filePath="/x/a.ts" before={'a\n'} after={'a\nb\n'} />,
    )
    expect(container.querySelector('.bs-diff-split')).toBeNull() // unified initially
    const toggle = container.querySelector('.bs-diff-toggle') as HTMLButtonElement
    fireEvent.click(toggle)
    expect(container.querySelector('.bs-diff-split')).not.toBeNull() // now split
    expect(toggle.textContent).toBe('unified')
    fireEvent.click(toggle)
    expect(container.querySelector('.bs-diff-split')).toBeNull() // back to unified
  })
})
