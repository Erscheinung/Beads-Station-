import { useSyncExternalStore } from 'react'

export type UiDensity = 'comfortable' | 'compact'

export interface UiCustomization {
  /** Percentage applied to application chrome typography, not terminal canvas dimensions. */
  interfaceScale: number
  density: UiDensity
}

export const UI_CUSTOMIZATION_KEY = 'beads-station.ui-customization.v1'
export const UI_SCALE_MIN = 80
export const UI_SCALE_MAX = 120
export const UI_SCALE_STEP = 5
export const DEFAULT_UI_CUSTOMIZATION: UiCustomization = {
  interfaceScale: 100,
  density: 'comfortable',
}

const listeners = new Set<() => void>()

function clampScale(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, Math.round(value)))
}

function validated(next: Partial<UiCustomization>, base: UiCustomization): UiCustomization {
  return {
    interfaceScale: clampScale(next.interfaceScale, base.interfaceScale),
    density: next.density === 'compact' || next.density === 'comfortable' ? next.density : base.density,
  }
}

function load(): UiCustomization {
  try {
    const parsed = JSON.parse(localStorage.getItem(UI_CUSTOMIZATION_KEY) || '{}') as Partial<UiCustomization>
    return validated(parsed, DEFAULT_UI_CUSTOMIZATION)
  } catch {
    return { ...DEFAULT_UI_CUSTOMIZATION }
  }
}

let state = load()

/**
 * Apply only cheap document-level presentation values. Deliberately avoids
 * CSS zoom/transform: xterm owns its canvas measurement and terminal font
 * settings remain in terminalAppearance.ts.
 */
function applyDocumentCustomization(value: UiCustomization): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.bsDensity = value.density
  root.style.setProperty('--bs-interface-scale', String(value.interfaceScale / 100))
  root.style.setProperty('--bs-interface-scale-percent', String(value.interfaceScale) + '%')
}

applyDocumentCustomization(state)

export const getUiCustomization = () => state
export function subscribeUiCustomization(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export function useUiCustomization() {
  return useSyncExternalStore(subscribeUiCustomization, getUiCustomization, getUiCustomization)
}

export function setUiCustomization(next: Partial<UiCustomization>): void {
  state = validated(next, state)
  applyDocumentCustomization(state)
  try { localStorage.setItem(UI_CUSTOMIZATION_KEY, JSON.stringify(state)) } catch { /* optional storage */ }
  listeners.forEach(listener => listener())
}

export function resetUiCustomization(): void {
  setUiCustomization(DEFAULT_UI_CUSTOMIZATION)
}
