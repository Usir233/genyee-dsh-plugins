import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // End-to-end and real-API suites have their own configs; the real-API one spends account balance.
    exclude: ['tests/e2e/**', 'tests/real-api/**'],
  },
})
