import { Store } from '@tauri-apps/plugin-store'

/**
 * Browser storage is scoped to a WebView origin. A dev server, an installed
 * DMG, and an upgraded app can therefore each have a different localStorage
 * namespace. Keep user configuration in the Tauri app-data store as well and
 * use browser storage only as the compatible local cache.
 *
 * The allowlist is deliberate. Provider-observed IDs, terminal pane snapshots,
 * native-run state, artifact revisions, and renderer recovery markers can
 * contain runtime context or bounded output; they are not user configuration
 * and must never be copied into this store.
 */
const STORE_FILE = 'user-preferences.json'
const STORE_KEY = 'config'
const DURABLE_EXACT_KEYS = new Set([
  'beads-station.ui-preferences',
  'beads-station.ui-customization.v1',
  'beads-station.terminal-appearance',
  'beads-station.theme',
  'beads-station.themePaletteId',
  'beads-station.view-themes.v1',
  'beads-station.skin',
  'beads-station.command-bindings.v1',
  'beads-station.recipe-bindings.v1',
  'beads-station.recipes.v1',
  'beads-station.session-preferences',
  'beads-station.notification-preferences',
  'beads-station.update-preferences',
  'beads-station.workspace-order.v1',
  'beads-station.workspaces.v2',
  'beads-station.workspaceRecents.v1',
  'beads-station.interactive-chat-provider',
  'beads-station.sidebarWidth',
  'beads-station.terminalHeight',
  'beads-station.designer-layout.v1',
])

const DURABLE_PREFIXES = ['beads-station.terminalHeight.']

export const DURABLE_CONFIG_SCHEMA_VERSION = 1 as const
export interface DurableUserConfig {
  schemaVersion: typeof DURABLE_CONFIG_SCHEMA_VERSION
  values: Record<string, string>
}

let storePromise: Promise<Store | null> | null = null
let hydratePromise: Promise<void> | null = null
let writeQueue: Promise<void> = Promise.resolve()

function isDurableKey(key: string): boolean {
  return DURABLE_EXACT_KEYS.has(key) || DURABLE_PREFIXES.some(prefix => key.startsWith(prefix))
}

export function isDurableUserConfigKey(key: string): boolean {
  return isDurableKey(key)
}

function readBrowserValues(): Record<string, string> {
  const values: Record<string, string> = {}
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (!key || !isDurableKey(key)) continue
      const value = localStorage.getItem(key)
      if (value !== null) values[key] = value
    }
  } catch {
    /* browser storage is optional */
  }
  return values
}

function validConfig(value: unknown): value is DurableUserConfig {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<DurableUserConfig>
  if (candidate.schemaVersion !== DURABLE_CONFIG_SCHEMA_VERSION || !candidate.values || typeof candidate.values !== 'object' || Array.isArray(candidate.values)) return false
  return Object.entries(candidate.values).every(([key, item]) => isDurableKey(key) && typeof item === 'string')
}

async function getStore(): Promise<Store | null> {
  if (storePromise === null) {
    storePromise = Store.load(STORE_FILE).catch(() => null)
  }
  return storePromise
}

function putBrowserValue(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* browser storage is optional */
  }
}

/**
 * Migrate existing browser preferences on first launch, or hydrate the cache
 * from app-data when the installed app has a fresh WebView origin. Native
 * values win when both stores contain a key; browser-only keys are retained so
 * an upgrade never discards an existing preference.
 */
export async function hydrateDurableUserConfig(): Promise<void> {
  if (hydratePromise) return hydratePromise
  hydratePromise = (async () => {
    const store = await getStore()
    if (!store) return
    const browserValues = readBrowserValues()
    let native: DurableUserConfig | null = null
    try {
      const saved = await store.get<unknown>(STORE_KEY)
      if (validConfig(saved)) native = saved
    } catch {
      return
    }

    const values = { ...browserValues, ...(native?.values ?? {}) }
    const migrated: DurableUserConfig = { schemaVersion: DURABLE_CONFIG_SCHEMA_VERSION, values }
    try {
      await store.set(STORE_KEY, migrated)
      await store.save()
      for (const [key, value] of Object.entries(values)) putBrowserValue(key, value)
    } catch {
      /* app-data persistence is best-effort; browser state remains usable */
    }
  })()
  return hydratePromise
}

/** Persist one allowlisted browser preference without copying runtime data. */
export function persistDurableUserConfigKey(key: string): void {
  if (!isDurableKey(key)) return
  writeQueue = writeQueue.then(async () => {
    const store = await getStore()
    if (!store) return
    let config: DurableUserConfig = { schemaVersion: DURABLE_CONFIG_SCHEMA_VERSION, values: {} }
    try {
      const saved = await store.get<unknown>(STORE_KEY)
      if (validConfig(saved)) config = saved
      const value = (() => {
        try { return localStorage.getItem(key) } catch { return null }
      })()
      if (value === null) delete config.values[key]
      else config.values[key] = value
      await store.set(STORE_KEY, config)
      await store.save()
    } catch {
      /* app-data persistence is best-effort */
    }
  }).catch(() => {})
}

export function __resetDurableUserConfigForTest(): void {
  storePromise = null
  hydratePromise = null
  writeQueue = Promise.resolve()
}
