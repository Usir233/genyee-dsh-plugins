import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/real-api/**/*.test.ts'],
    testTimeout: 180_000,
    // Real requests cost money; run them one at a time.
    fileParallelism: false,
  },
})
