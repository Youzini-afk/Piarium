import { RunServicesError, parseRunServicesFailureReason } from '@piarium/ui/lib/api/run-errors';
import { runtimeFetch } from '@piarium/ui/lib/runtime-fetch';
import {
  getRuntimeEndpointGeneration,
  subscribeRuntimeEndpointWillChange,
} from '@piarium/ui/lib/runtime-switch';
import type { Subscription } from '@piarium/ui/lib/api/types';

const assertRunGeneration = (generation: number): void => {
  if (generation !== getRuntimeEndpointGeneration()) {
    throw new RunServicesError('Application host endpoint changed', { reason: 'stale-completion' });
  }
};

export const postRunJson = async (path: string, body: unknown): Promise<unknown> => {
  const generation = getRuntimeEndpointGeneration();
  const response = await runtimeFetch(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assertRunGeneration(generation);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText })) as {
      error?: string;
      reason?: unknown;
    };
    throw new RunServicesError(error.error || 'Run request failed', {
      reason: parseRunServicesFailureReason(error.reason),
      status: response.status,
    });
  }
  return response.json();
};

const readSseEvents = async <T>(
  response: Response,
  listener: (event: T) => void,
  signal: AbortSignal,
): Promise<void> => {
  const reader = response.body?.getReader();
  if (!reader) throw new RunServicesError('Run event stream is unavailable', { reason: 'failed' });
  const decoder = new TextDecoder();
  let buffer = '';
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const line = chunk.split('\n').find((entry) => entry.startsWith('data: '));
      if (!line) continue;
      const event = JSON.parse(line.slice(6)) as T;
      if (event && typeof event === 'object' && 'content' in event) continue;
      listener(event);
    }
  }
};

export const subscribeRunSse = <T>(
  path: string,
  workspaceId: string,
  listener: (event: T) => void,
  options?: { signal?: AbortSignal },
): Subscription => {
  const generation = getRuntimeEndpointGeneration();
  const controller = new AbortController();
  if (options?.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const unsubscribe = subscribeRuntimeEndpointWillChange(() => controller.abort());
  void (async () => {
    try {
      assertRunGeneration(generation);
      const response = await runtimeFetch(path, {
        headers: { Accept: 'text/event-stream' },
        query: { workspaceId },
        signal: controller.signal,
      });
      assertRunGeneration(generation);
      if (!response.ok) {
        throw new RunServicesError('Run event stream failed', {
          reason: 'failed',
          status: response.status,
        });
      }
      await readSseEvents(response, listener, controller.signal);
    } catch {
      if (controller.signal.aborted) return;
    } finally {
      unsubscribe();
    }
  })();
  return {
    close() {
      unsubscribe();
      controller.abort();
    },
  };
};
