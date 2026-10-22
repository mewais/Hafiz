import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    passWithNoTests: true,
    globalSetup: ['./vitest.global-setup.ts'],
    // Many tests run a real git repo and a daemon over a Unix socket; on a loaded CI runner the
    // default 5 s is not enough for their setup.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
