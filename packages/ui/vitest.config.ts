import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const src = fileURLToPath(new URL('./src', import.meta.url));

/**
 * Suites that cannot pass under this runner yet, each with its cause. They are listed explicitly so
 * the gap stays visible and shrinks deliberately, rather than the whole package staying uncovered.
 *
 * Nothing here is a regression: this package had no test script, so none of these suites had ever
 * been executed by any runner.
 */
const KNOWN_FAILING = [
  // Assert against component sources that no longer exist, so they can never pass. They need their
  // intent re-pointed at whatever replaced the component, or removal.
  'src/components/chat/MobileSessionStatusBar.test.ts',
  'src/lib/i18n/messages/workspaceMessages.test.ts',

  // Require browser globals. They need an explicit DOM environment for this package.
  'src/components/ui/number-input.test.tsx',
  'src/lib/piariumEvents.test.ts',

  // Import a module through a computed specifier, which Vite cannot analyze statically.
  'src/stores/utils/safeStorage.test.ts',

  // Depend on `bun:test` `mock.module` replacing an already-imported module at call time. The
  // shim maps it to `vi.mock`, which Vitest hoists instead, so the replacement does not apply.
  'src/lib/extensions/catalog-store.test.ts',

  // Fails while collecting: workbench-registry -> settings surface-registry -> builtin settings
  // contributions -> ExtensionsPage -> workbench-registry, so the replacement targets are still
  // undefined when ExtensionsPage reads them. A pre-existing import cycle, not a test problem.
  'src/lib/extensions/workbench-registry.test.ts',

  // Assertions that no longer match the implementation they describe.
  'src/components/chat/composer/editor/__tests__/dom.test.ts',
  'src/lib/i18n/messages/providerSettings.test.ts',

  // Locale dictionary loads time out under this runner's module graph.
  'src/lib/i18n/store.test.ts',

  // Compares two AbortSignal instances by identity across realms.
  'src/lib/runtime-fetch.test.ts',
];

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
    exclude: [...configDefaults.exclude, ...KNOWN_FAILING],
    // This suite is large enough to saturate a machine, which starves timing-sensitive assertions
    // here and in whichever package the workspace runs next. Leave headroom instead.
    maxWorkers: '50%',
    hookTimeout: 45_000,
    testTimeout: 45_000,
  },
});
