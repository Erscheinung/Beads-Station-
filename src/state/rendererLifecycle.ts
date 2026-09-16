const DIRTY_KEY = 'beads-station.renderer-dirty.v1'

let recovered = false
let bootMarked = false

/** Mark this renderer as open. A leftover marker means the prior renderer could not run its close path. */
export function markRendererBoot(): boolean {
  if (bootMarked) return recovered
  bootMarked = true
  try {
    recovered = localStorage.getItem(DIRTY_KEY) !== null
    localStorage.setItem(DIRTY_KEY, String(Date.now()))
  } catch { recovered = false }
  return recovered
}

export function markRendererActive(): void {
  try { localStorage.setItem(DIRTY_KEY, String(Date.now())) } catch { /* optional */ }
}

export function markRendererCleanExit(): void {
  try { localStorage.removeItem(DIRTY_KEY) } catch { /* optional */ }
}

export function recoveredFromUngracefulExit(): boolean {
  return recovered
}
