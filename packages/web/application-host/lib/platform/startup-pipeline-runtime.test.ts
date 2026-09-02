import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { createStartupPipelineRuntime } from './startup-pipeline-runtime.js';

describe('startup pipeline runtime', () => {
  it('publishes the listening port before attaching process handlers', async () => {
    const order: string[] = [];
    const runtime = createStartupPipelineRuntime({
      createTerminalRuntime: () => ({ shutdown: async () => {} }),
      createDictationRuntime: () => ({ stop: () => {} }),
      createServerStartupRuntime: () => ({
        resolveBindHost: () => '127.0.0.1',
        startListeningAndMaybeTunnel: async () => {
          order.push('listen');
          return { activePort: 3901 };
        },
        attachProcessHandlers: vi.fn(),
      }),
    });

    const options = {
      app: {},
      staticRoutesRuntime: { registerStaticRoutes: vi.fn() },
      apiOnly: false,
      tunnelRuntimeContext: {
        setActivePort: (port: number) => order.push(`port:${port}`),
      },
      process: {},
      crypto: {},
      server: {},
      attachSignals: false,
    } as unknown as Parameters<typeof runtime.run>[0];
    await runtime.run(options);

    expect(order).toEqual(['listen', 'port:3901']);
  });

  it('has no OpenCode lifecycle or proxy dependency', () => {
    const source = readFileSync(new URL('./startup-pipeline-runtime.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('OpenCode');
    expect(source).not.toContain('setupProxy');
    expect(source).not.toContain('messageStream');
  });
});
