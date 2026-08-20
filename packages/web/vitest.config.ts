import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const uiSrc = fileURLToPath(new URL('../ui/src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: 'bun:test', replacement: fileURLToPath(new URL('./test/bun-test-shim.ts', import.meta.url)) },
      { find: '@piarium/ui', replacement: uiSrc },
      { find: '@', replacement: uiSrc },
    ],
  },
  test: {
    hookTimeout: 45_000,
    testTimeout: 45_000,
  },
});
