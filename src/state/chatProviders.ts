import { useEffect, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { persistDurableUserConfigKey } from '../lib/durableUserConfig'

/** Providers with a first-party adapter in this build. Keep this union narrow. */
export type InteractiveChatProvider = 'claude' | 'codex'

export interface NativeProviderAvailability {
  provider: InteractiveChatProvider
  available: boolean
  executable: string | null
  detail: string
}

const PROVIDER_KEY = 'beads-station.interactive-chat-provider'
const PROVIDERS: readonly InteractiveChatProvider[] = ['claude', 'codex']

function isProvider(value: unknown): value is InteractiveChatProvider {
  return typeof value === 'string' && PROVIDERS.includes(value as InteractiveChatProvider)
}

function loadProvider(): InteractiveChatProvider {
  try {
    const value = localStorage.getItem(PROVIDER_KEY)
    if (isProvider(value)) return value
  } catch { /* optional storage */ }
  return 'claude'
}

let provider = loadProvider()
const providerListeners = new Set<() => void>()

export function getInteractiveChatProvider(): InteractiveChatProvider {
  return provider
}

export function setInteractiveChatProvider(next: InteractiveChatProvider): void {
  if (!isProvider(next) || next === provider) return
  provider = next
  try { localStorage.setItem(PROVIDER_KEY, provider) } catch { /* optional storage */ }
  persistDurableUserConfigKey(PROVIDER_KEY)
  providerListeners.forEach(listener => listener())
}

export function useInteractiveChatProvider(): InteractiveChatProvider {
  return useSyncExternalStore(
    listener => { providerListeners.add(listener); return () => providerListeners.delete(listener) },
    getInteractiveChatProvider,
    getInteractiveChatProvider,
  )
}

let availability: NativeProviderAvailability[] | null = null
let availabilityRequest: Promise<void> | null = null
const availabilityListeners = new Set<() => void>()

function fallbackAvailability(detail: string): NativeProviderAvailability[] {
  return PROVIDERS.map(name => ({ provider: name, available: false, executable: null, detail }))
}

function normalizeAvailability(value: unknown): NativeProviderAvailability[] {
  if (!Array.isArray(value)) return fallbackAvailability('Provider discovery returned no status')
  return PROVIDERS.map(name => {
    const found = value.find(item => item && typeof item === 'object' && (item as { provider?: unknown }).provider === name) as Partial<NativeProviderAvailability> | undefined
    return {
      provider: name,
      available: found?.available === true,
      executable: typeof found?.executable === 'string' ? found.executable : null,
      detail: typeof found?.detail === 'string' ? found.detail : found?.available === true ? 'Installed' : 'Unavailable',
    }
  })
}

export function getNativeProviderAvailability(): NativeProviderAvailability[] | null {
  return availability
}

/** Binary capability discovery only. It never starts a provider or reads auth. */
export function refreshNativeProviderAvailability(): Promise<void> {
  if (availabilityRequest) return availabilityRequest
  availabilityRequest = invoke<NativeProviderAvailability[]>('native_provider_status')
    .then(value => { availability = normalizeAvailability(value) })
    .catch(error => { availability = fallbackAvailability(String(error)) })
    .finally(() => {
      availabilityRequest = null
      availabilityListeners.forEach(listener => listener())
    })
  return availabilityRequest
}

export function useNativeProviderAvailability(): NativeProviderAvailability[] | null {
  const current = useSyncExternalStore(
    listener => { availabilityListeners.add(listener); return () => availabilityListeners.delete(listener) },
    getNativeProviderAvailability,
    getNativeProviderAvailability,
  )
  useEffect(() => {
    if (availability === null) void refreshNativeProviderAvailability()
  }, [])
  return current
}

export function providerLabel(value: InteractiveChatProvider): string {
  return value === 'claude' ? 'Claude' : 'Codex'
}

export function providerAvailability(
  providers: NativeProviderAvailability[] | null,
  providerName: InteractiveChatProvider,
): NativeProviderAvailability | null {
  return providers?.find(item => item.provider === providerName) ?? null
}
