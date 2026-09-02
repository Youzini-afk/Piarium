import type { TunnelProvider, TunnelProviderCapabilities, TunnelProviderId } from './types.js';

const REQUIRED_PROVIDER_METHODS = ['start', 'stop', 'checkAvailability', 'resolvePublicUrl'];

export interface TunnelProviderRegistry {
  get(providerId: unknown): TunnelProvider | null;
  list(): TunnelProvider[];
  listCapabilities(): TunnelProviderCapabilities[];
  register(provider: TunnelProvider): TunnelProvider;
  seal(): void;
}

export function createTunnelProviderRegistry(
  initialProviders: TunnelProvider[] = [],
): TunnelProviderRegistry {
  const providers = new Map<TunnelProviderId, TunnelProvider>();
  let sealed = false;

  const register = (provider: TunnelProvider): TunnelProvider => {
    if (sealed) {
      throw new Error('Tunnel provider registry is sealed; no further registrations allowed');
    }
    if (!provider || typeof provider.id !== 'string' || provider.id.trim().length === 0) {
      throw new Error('Tunnel provider must define a non-empty id');
    }
    const providerRecord = provider as unknown as Record<string, unknown>;
    for (const method of REQUIRED_PROVIDER_METHODS) {
      if (typeof providerRecord[method] !== 'function') {
        throw new Error(`Tunnel provider '${provider.id}' must implement ${method}()`);
      }
    }
    const key = provider.id.trim().toLowerCase() as TunnelProviderId;
    if (providers.has(key)) {
      throw new Error(`Tunnel provider '${key}' is already registered`);
    }
    providers.set(key, provider);
    return provider;
  };

  const get = (providerId: unknown): TunnelProvider | null => {
    if (typeof providerId !== 'string' || providerId.trim().length === 0) {
      return null;
    }
    return providers.get(providerId.trim().toLowerCase() as TunnelProviderId) ?? null;
  };

  const list = (): TunnelProvider[] => Array.from(providers.values());

  const listCapabilities = (): TunnelProviderCapabilities[] => list().map((provider) => ({ ...provider.capabilities }));

  for (const provider of initialProviders) {
    register(provider);
  }

  const seal = (): void => { sealed = true; };

  return {
    register,
    get,
    list,
    listCapabilities,
    seal,
  };
}
