/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // tests/live/* are Playwright specs (npm run test:live), not vitest —
    // they import @playwright/test which vitest can't collect.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/live/**'],
  },
})
