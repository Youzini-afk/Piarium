import type {
  ProviderAuthEvent,
  ProviderAuthPrompt,
  ProviderAuthType,
  ProviderConfigDeleteScope,
  ProviderConfigInput,
  ProviderConfigScope,
} from '@piarium/protocol';
import { getPiRuntimeConnection } from './client';

export const listPiProviders = async (cwd: string) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('provider.list', { cwd });
};

export const listPiModels = async (cwd: string) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('model.list', { cwd });
};

export const getPiProviderConfig = async (cwd: string, providerId: string) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('provider.config.get', { cwd, providerId });
};

export const upsertPiProviderConfig = async (
  cwd: string,
  scope: ProviderConfigScope,
  config: ProviderConfigInput,
) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('provider.config.upsert', { config, cwd, scope });
};

export const deletePiProviderConfig = async (
  cwd: string,
  providerId: string,
  scope: ProviderConfigDeleteScope,
) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('provider.config.delete', { cwd, providerId, scope });
};

export interface PiProviderDiscoveryOptions {
  apiKey?: string;
  config?: ProviderConfigInput;
}

export const discoverPiProviderModels = async (
  cwd: string,
  providerId: string,
  options: PiProviderDiscoveryOptions = {},
) => {
  const { client } = await getPiRuntimeConnection();
  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    return client.request('provider.models.discover', {
      ...(options.config === undefined ? {} : { config: options.config }),
      cwd,
      providerId,
    }, null);
  }

  const pendingResponses = new Set<Promise<void>>();
  let promptFailure: unknown;
  const unsubscribe = client.subscribe((envelope) => {
    if (envelope.event !== 'provider.auth.prompt') return;
    if (envelope.data.providerId !== providerId) return;
    const response = client.request('provider.auth.respond', {
      response: {
        requestId: envelope.data.prompt.requestId,
        value: apiKey,
      },
      sessionId: envelope.data.sessionId,
    }, null).then(() => undefined).catch((error: unknown) => {
      promptFailure = error;
    }).finally(() => pendingResponses.delete(response));
    pendingResponses.add(response);
  });
  try {
    const result = await client.request('provider.models.discover', {
      ...(options.config === undefined ? {} : { config: options.config }),
      cwd,
      providerId,
      requestCredential: true,
    }, null);
    await Promise.all(pendingResponses);
    if (promptFailure !== undefined) throw promptFailure;
    return result;
  } finally {
    unsubscribe();
  }
};

export interface PiProviderLoginOptions {
  cwd: string;
  onEvent?(event: ProviderAuthEvent): void;
  onPrompt(prompt: ProviderAuthPrompt): Promise<string | undefined>;
  providerId: string;
  type: ProviderAuthType;
}

/**
 * Runs one canonical Pi login interaction. The browser subscribes before the
 * request starts, and every credential prompt is answered through the same
 * catalog worker that emitted it. Credentials never enter provider config or
 * renderer persistence.
 */
export const loginPiProvider = async (options: PiProviderLoginOptions) => {
  const { client } = await getPiRuntimeConnection();
  const pendingResponses = new Set<Promise<void>>();
  let promptFailure: unknown;

  const unsubscribe = client.subscribe((envelope) => {
    if (envelope.event === 'provider.auth.event') {
      if (envelope.data.providerId !== options.providerId) return;
      options.onEvent?.(envelope.data.event);
      return;
    }
    if (envelope.event !== 'provider.auth.prompt') return;
    if (envelope.data.providerId !== options.providerId) return;

    const respond = async (value: string | undefined) => {
        await client.request('provider.auth.respond', {
          response: {
            ...(value === undefined ? { cancelled: true } : { value }),
            requestId: envelope.data.prompt.requestId,
          },
          sessionId: envelope.data.sessionId,
        }, null);
    };
    const response = Promise.resolve(options.onPrompt(envelope.data.prompt))
      .then(respond)
      .catch(async (error: unknown) => {
        promptFailure = error;
        await respond(undefined);
      })
      .finally(() => pendingResponses.delete(response));
    pendingResponses.add(response);
  });

  try {
    const result = await client.request('provider.login', {
      cwd: options.cwd,
      providerId: options.providerId,
      type: options.type,
    }, null);
    await Promise.all(pendingResponses);
    if (promptFailure !== undefined) throw promptFailure;
    return result;
  } finally {
    unsubscribe();
  }
};
