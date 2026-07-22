import '@testing-library/jest-dom/vitest'

// React 19 + RTL: opt into act() support so state updates flush synchronously
// inside act(...) and RTL's async helpers. Without this, updates queued during
// a test are dropped with "environment is not configured to support act(...)".
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
