import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetWorkspaceOrderForTest,
  moveWorkspace,
  reconcileWorkspaceOrder,
  reorderWorkspace,
  workspaceOrder,
} from './workspaceOrder'

describe('persistent workspace tab order', () => {
  beforeEach(() => __resetWorkspaceOrderForTest())

  it('keeps explicit order and appends newly opened workspaces', () => {
    reconcileWorkspaceOrder(['a', 'b', 'c'])
    reorderWorkspace('c', 'a')
    expect(workspaceOrder(['a', 'b', 'c'])).toEqual(['c', 'a', 'b'])
    reconcileWorkspaceOrder(['c', 'a', 'b', 'd'])
    expect(workspaceOrder(['d', 'b', 'a', 'c'])).toEqual(['c', 'a', 'b', 'd'])
  })

  it('drops closed workspaces without changing surviving relative order', () => {
    reconcileWorkspaceOrder(['a', 'b', 'c'])
    reorderWorkspace('a', 'c')
    reconcileWorkspaceOrder(['a', 'c'])
    expect(workspaceOrder(['a', 'c'])).toEqual(['c', 'a'])
  })

  it('moves one workspace at a time and clamps at boundaries', () => {
    reconcileWorkspaceOrder(['a', 'b', 'c'])
    moveWorkspace('b', -1)
    expect(workspaceOrder(['a', 'b', 'c'])).toEqual(['b', 'a', 'c'])
    moveWorkspace('b', -1)
    expect(workspaceOrder(['a', 'b', 'c'])).toEqual(['b', 'a', 'c'])
    moveWorkspace('b', 1)
    expect(workspaceOrder(['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })
})

