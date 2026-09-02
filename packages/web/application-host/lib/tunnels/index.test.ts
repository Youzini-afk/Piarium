import { describe, expect, it } from 'vitest';

import { createTunnelService } from './index.js';
import {
  TUNNEL_INTENT_EPHEMERAL_PUBLIC,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TUNNEL_PROVIDER_NGROK,
  TunnelServiceError,
  type TunnelController,
  type TunnelProvider,
  type TunnelProviderId,
} from './types.js';

const createProvider = ({
  provider,
  start,
  stop = (controller) => controller.stop?.(),
  resolvePublicUrl = (controller) => controller?.getPublicUrl?.() ?? null,
}: {
  provider: TunnelProviderId;
  resolvePublicUrl?: TunnelProvider['resolvePublicUrl'] | undefined;
  start: TunnelProvider['start'];
  stop?: TunnelProvider['stop'] | undefined;
}): TunnelProvider => ({
  id: provider,
  capabilities: {
    provider,
    modes: [{ key: TUNNEL_MODE_QUICK, intent: TUNNEL_INTENT_EPHEMERAL_PUBLIC }],
  },
  checkAvailability: async () => ({ available: true }),
  start,
  stop,
  resolvePublicUrl,
});

const createRegistry = (providers: Partial<Record<TunnelProviderId, TunnelProvider>>) => ({
  get: (providerId: unknown) => typeof providerId === 'string'
    ? providers[providerId as TunnelProviderId] ?? null
    : null,
});

describe('createTunnelService', () => {
  it('returns provider startup errors to route callers', async () => {
    let controller: TunnelController | null = null;
    const provider = createProvider({
      provider: TUNNEL_PROVIDER_NGROK,
      start: async () => {
        throw new Error('ngrok authtoken is not configured');
      },
    });
    const service = createTunnelService({
      registry: createRegistry({ [TUNNEL_PROVIDER_NGROK]: provider }),
      getController: () => controller,
      setController: (next) => { controller = next; },
      getActivePort: () => 3000,
    });

    try {
      await service.start({ provider: TUNNEL_PROVIDER_NGROK, mode: TUNNEL_MODE_QUICK });
      throw new Error('Expected service.start to fail');
    } catch (error) {
      if (!(error instanceof TunnelServiceError)) throw error;
      expect(error.name).toBe('TunnelServiceError');
      expect(error.code).toBe('startup_failed');
      expect(error.message).toBe('ngrok authtoken is not configured');
    }
  });

  it('replaces an active quick tunnel when the provider changes', async () => {
    let stopped = false;
    let ngrokStarted = false;
    const initialController: TunnelController = {
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      mode: TUNNEL_MODE_QUICK,
      stop: () => { stopped = true; },
      getPublicUrl: () => 'https://cloudflare.example',
    };
    let controller: TunnelController | null = initialController;
    const cloudflareProvider = createProvider({
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      start: async () => initialController,
    });
    const ngrokProvider = createProvider({
      provider: TUNNEL_PROVIDER_NGROK,
      start: async () => {
        ngrokStarted = true;
        return {
          mode: TUNNEL_MODE_QUICK,
          getPublicUrl: () => 'https://demo.ngrok-free.app',
        };
      },
    });
    const service = createTunnelService({
      registry: createRegistry({
        [TUNNEL_PROVIDER_CLOUDFLARE]: cloudflareProvider,
        [TUNNEL_PROVIDER_NGROK]: ngrokProvider,
      }),
      getController: () => controller,
      setController: (next) => { controller = next; },
      getActivePort: () => 3000,
    });

    const result = await service.start({ provider: TUNNEL_PROVIDER_NGROK, mode: TUNNEL_MODE_QUICK });

    expect(stopped).toBe(true);
    expect(ngrokStarted).toBe(true);
    expect(result.provider).toBe(TUNNEL_PROVIDER_NGROK);
    expect(result.publicUrl).toBe('https://demo.ngrok-free.app');
  });
});
