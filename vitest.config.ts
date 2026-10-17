import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/**/*.test.ts'], exclude: ['tests/live/**'] } },
      { test: { name: 'live', include: ['tests/live/**/*.live.test.ts'], testTimeout: 900_000 } },
    ],
  },
});
