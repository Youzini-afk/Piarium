import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['updater-*.test.ts', 'linux-autostart.test.ts'],
    testTimeout: 30_000,
  },
});
