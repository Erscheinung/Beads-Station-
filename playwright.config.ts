import { defineConfig, devices } from '@playwright/test'

// R12 live-verify — drives Chromium against the vite dev server running in
// browser-mock mode (VITE_LIVE_MOCK=1), so real focus/keydown/render is
// exercised without a Tauri runtime. See src/test-harness/ for the IPC shim.
export default defineConfig({
  testDir: './tests/live',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  retries: 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: 'http://localhost:1422',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'VITE_LIVE_MOCK=1 npm run dev -- --port 1422',
    url: 'http://localhost:1422',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
