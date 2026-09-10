/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    // Avoid spawning a jsdom process per CPU on a developer's laptop.
    maxWorkers: 2,
    // Node 25 exposes an unconfigured native localStorage object. Tests need
    // jsdom's browser storage, not Node's optional file-backed implementation.
    pool: 'forks',
    poolOptions: { forks: {
      execArgv: process.allowedNodeEnvironmentFlags.has('--no-experimental-webstorage') ? ['--no-experimental-webstorage'] : [],
    } },
    setupFiles: ['./src/test/setup.ts'],
    // tests/live/* are Playwright specs (npm run test:live), not vitest —
    // they import @playwright/test which vitest can't collect.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/live/**'],
  },
})
