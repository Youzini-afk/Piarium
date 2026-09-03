import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const uiSrc = fileURLToPath(new URL('../ui/src', import.meta.url));
const applicationHostSrc = fileURLToPath(new URL('./application-host', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: 'bun:test', replacement: fileURLToPath(new URL('./test/bun-test-shim.ts', import.meta.url)) },
      // CLI sources address the Application Host through a private package import so the
      // published bin/ output resolves server/. Tests run against Host source instead,
      // which keeps them working in a clean checkout with nothing generated yet.
      { find: '#application-host', replacement: applicationHostSrc },
      { find: '@piarium/ui', replacement: uiSrc },
      { find: '@', replacement: uiSrc },
    ],
  },
  test: {
    hookTimeout: 45_000,
    testTimeout: 45_000,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-ssr/**',
      // Node smoke tests use node:test, not vitest — run with `node --test` instead.
      '**/*.smoke.test.ts',
    ],
  },
});
