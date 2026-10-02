import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../lib/durableUserConfig', () => ({ persistDurableUserConfigKey: vi.fn() }))

import { __resetAppUpdateForTest, checkForUpdates, checkForUpdatesOnLaunch, downloadUpdate, setCheckForUpdatesOnLaunch, useAppUpdate } from './appUpdate'
import { renderHook, waitFor } from '@testing-library/react'

const newer = { current: '0.1.5', latest: 'v0.1.6', newer: true, url: 'https://example.invalid/v0.1.6', asset: 'Beads.Station_0.1.6_aarch64.dmg' }

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  __resetAppUpdateForTest()
})

describe('release check', () => {
  it('reports a newer release and downloads it only on request', async () => {
    mocks.invoke.mockImplementation(async command => command === 'app_check_update' ? newer : { path: '/tmp/x.dmg', checksumVerified: true })
    const { result } = renderHook(() => useAppUpdate())
    await checkForUpdates()
    await waitFor(() => expect(result.current).toMatchObject({ status: 'available', info: newer }))
    expect(mocks.invoke).not.toHaveBeenCalledWith('app_download_update', expect.anything())
    await downloadUpdate()
    expect(mocks.invoke).toHaveBeenCalledWith('app_download_update', { tag: 'v0.1.6' })
    await waitFor(() => expect(result.current).toMatchObject({ status: 'downloaded', path: '/tmp/x.dmg', checksumVerified: true }))
  })
  it('reports up to date, and shows a manual check failure', async () => {
    mocks.invoke.mockResolvedValueOnce({ ...newer, latest: 'v0.1.5', newer: false })
    const { result } = renderHook(() => useAppUpdate())
    await checkForUpdates()
    await waitFor(() => expect(result.current.status).toBe('current'))
    await downloadUpdate()
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
    mocks.invoke.mockRejectedValueOnce('offline')
    await checkForUpdates()
    await waitFor(() => expect(result.current).toMatchObject({ status: 'error', message: 'offline' }))
  })
  it('checks once per launch, stays silent on failure, and respects the preference', async () => {
    mocks.invoke.mockRejectedValue('offline')
    const { result } = renderHook(() => useAppUpdate())
    checkForUpdatesOnLaunch()
    checkForUpdatesOnLaunch()
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current.status).toBe('idle'))

    __resetAppUpdateForTest()
    setCheckForUpdatesOnLaunch(false)
    mocks.invoke.mockClear()
    checkForUpdatesOnLaunch()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
