import { beforeEach, describe, expect, it, vi } from 'vitest'

// Code-jx3.2/jx3.3 — the on-demand conductor bridge wrappers invoke the right
// Rust command with the right snake_case payload. Mocks @tauri-apps/api/core.

const invoke = vi.fn((_cmd: string, _args?: unknown) => Promise.resolve())
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}))

import {
  conductorPulseNow,
  conductorStopAgent,
  conductorDeferBead,
} from './conductorBridge'

describe('conductor on-demand bridge', () => {
  beforeEach(() => invoke.mockClear())

  it('conductorPulseNow invokes conductor_pulse_now with repo+bead+dryRun', async () => {
    await conductorPulseNow('/repo/a', 'Code-x')
    expect(invoke).toHaveBeenCalledWith('conductor_pulse_now', {
      repoPath: '/repo/a',
      beadId: 'Code-x',
      dryRun: true,
    })
  })

  it('conductorPulseNow forwards an explicit dryRun=false', async () => {
    await conductorPulseNow('/repo/a', 'Code-x', false)
    expect(invoke).toHaveBeenCalledWith('conductor_pulse_now', {
      repoPath: '/repo/a',
      beadId: 'Code-x',
      dryRun: false,
    })
  })

  it('conductorStopAgent invokes conductor_stop_agent with beadId', async () => {
    await conductorStopAgent('Code-y')
    expect(invoke).toHaveBeenCalledWith('conductor_stop_agent', { beadId: 'Code-y' })
  })

  it('conductorDeferBead invokes conductor_defer_bead with repo+bead', async () => {
    await conductorDeferBead('/repo/a', 'Code-z')
    expect(invoke).toHaveBeenCalledWith('conductor_defer_bead', {
      repoPath: '/repo/a',
      beadId: 'Code-z',
    })
  })
})
