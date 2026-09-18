import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['*.test.ts'],
    // Owned by test:updater and test:linux-desktop so each file runs exactly
    // once per environment instead of inside the architecture pass and again
    // through its dedicated entry.
    exclude: ['updater-*.test.ts', 'linux-autostart.test.ts'],
    testTimeout: 30_000,
  },
});
