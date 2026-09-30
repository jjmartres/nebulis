import { defineConfig } from 'vitest/config';

/** Import Lab tier 3: talks to the Docker lab (npm run lab:up) over HTTP. Not part of `npm run test`. */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/lab/**/*.test.ts'],
    testTimeout: 240_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
