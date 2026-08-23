import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const src = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: 'bun:test', replacement: fileURLToPath(new URL('./test/bun-test-shim.ts', import.meta.url)) },
      { find: '@piarium/ui', replacement: src },
      { find: '@', replacement: src },
    ],
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: configDefaults.exclude,
    // This suite is large enough to saturate a machine, which starves timing-sensitive assertions
    // here and in whichever package the workspace runs next. Leave headroom instead.
    maxWorkers: '50%',
    hookTimeout: 45_000,
    testTimeout: 45_000,
  },
});
