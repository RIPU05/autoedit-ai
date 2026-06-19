import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 1000 * 60 * 90, // long enough for the 1h-podcast e2e scenario
    hookTimeout: 1000 * 60 * 10,
  },
});
