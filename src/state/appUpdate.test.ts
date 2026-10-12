import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../lib/durableUserConfig', () => ({ persistDurableUserConfigKey: vi.fn() }))

import { __resetAppUpdateForTest, checkForUpdates, checkForUpdatesOnLaunch, downloadUpdate, setCheckForUpdatesOnLaunch, useAppUpdate, prepareUpdate, restartToUpdate } from './appUpdate'
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
  it('prepares an update without applying it, and applies only on restart', async () => {
    mocks.invoke.mockResolvedValueOnce(newer)
    const { result } = renderHook(() => useAppUpdate())
    await restartToUpdate()
    expect(mocks.invoke).not.toHaveBeenCalled()
    await checkForUpdates()
    await waitFor(() => expect(result.current.status).toBe('available'))
    mocks.invoke.mockResolvedValueOnce({ version: 'v0.1.6', bundle: '/Applications/Beads Station.app' })
    await prepareUpdate()
    expect(mocks.invoke).toHaveBeenLastCalledWith('app_prepare_update', { tag: 'v0.1.6' })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(mocks.invoke).not.toHaveBeenCalledWith('app_apply_update')
    mocks.invoke.mockResolvedValueOnce(null)
    await restartToUpdate()
    expect(mocks.invoke).toHaveBeenLastCalledWith('app_apply_update')
  })
  it('a release that cannot be installed automatically says why and keeps the download path', async () => {
    mocks.invoke.mockResolvedValueOnce(newer)
    const { result } = renderHook(() => useAppUpdate())
    await checkForUpdates()
    mocks.invoke.mockRejectedValueOnce('This release publishes no SHA-256')
    await prepareUpdate()
    await waitFor(() => expect(result.current).toMatchObject({ status: 'error', message: 'This release publishes no SHA-256', info: { newer: true } }))
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
