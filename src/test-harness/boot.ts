// Beads Station — R12 live-verify harness
// Boot shim: installs the browser-mode mockIPC before React mounts.
// Imported dynamically from main.tsx only when import.meta.env.VITE_LIVE_MOCK
// is set, so neither this file nor mockIpc/fixtures reach a prod bundle.

export { installMockIpc } from './mockIpc'
