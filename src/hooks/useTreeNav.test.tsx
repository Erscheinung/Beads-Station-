import { StrictMode } from 'react'
import { renderHook, act } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useTreeNav } from './useTreeNav'
import type { Issue } from '../types/issue'

describe('explorer expansion', () => {
  it('expands asynchronously discovered groups in StrictMode and respects manual collapse', () => {
    const { result, rerender } = renderHook(({ issues }) => useTreeNav(issues), {
      initialProps: { issues: [] as Issue[] },
      wrapper: StrictMode,
    })
    const issue = { id: 'one', title: 'Visible bead', status: 'open', labels: ['project'] } as Issue
    rerender({ issues: [issue] })
    expect(result.current.rows.some(row => row.node.issue?.id === 'one')).toBe(true)
    const group = result.current.rows.find(row => row.node.kind === 'status')!
    act(() => result.current.toggle(group.node.id))
    rerender({ issues: [{ ...issue, title: 'Updated' }] })
    expect(result.current.expanded.has(group.node.id)).toBe(false)
  })
})
