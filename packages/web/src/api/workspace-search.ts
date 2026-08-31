import type {
  WorkspaceContentSearchRequest,
  WorkspaceContentSearchResult,
  WorkspaceContentSearchHit,
  WorkspaceSearchAPI,
} from '@piarium/application-client';
import { WorkspaceSearchError, parseWorkspaceSearchFailureReason } from '@piarium/application-client';
import { runtimeFetch } from '@piarium/application-client';
import { getRuntimeEndpointGeneration } from '@piarium/application-client';

const assertGeneration = (generation: number): void => {
  if (generation !== getRuntimeEndpointGeneration()) {
    throw new WorkspaceSearchError('Application host endpoint changed', { reason: 'stale-completion' });
  }
};

const readNdjsonSearch = async (
  response: Response,
  generation: number,
  onBatch?: (hits: WorkspaceContentSearchHit[]) => void,
): Promise<WorkspaceContentSearchResult> => {
  if (!response.body) throw new WorkspaceSearchError('Workspace search returned no stream', { reason: 'failed' });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const hits: Extract<WorkspaceContentSearchResult, { status: 'ready' }>['hits'] = [];
  let finalResult: WorkspaceContentSearchResult | null = null;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const frame = JSON.parse(line) as {
      type?: unknown;
      hits?: unknown;
      result?: WorkspaceContentSearchResult;
    };
    assertGeneration(generation);
    if (frame.type === 'batch' && Array.isArray(frame.hits)) {
      const batch = frame.hits as typeof hits;
      hits.push(...batch);
      onBatch?.(batch);
      return;
    }
    if (frame.type === 'result' && frame.result && typeof frame.result.status === 'string') {
      finalResult = frame.result.status === 'ready'
        ? { status: 'ready', generation, hits: [...hits] }
        : frame.result;
      return;
    }
    throw new WorkspaceSearchError('Workspace search returned an invalid stream frame', { reason: 'failed' });
  };
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      consume(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (!finalResult) throw new WorkspaceSearchError('Workspace search stream ended without a result', { reason: 'failed' });
  return finalResult;
};

export const createWebWorkspaceSearchAPI = (): WorkspaceSearchAPI => ({
  async searchContent(request: WorkspaceContentSearchRequest, options): Promise<WorkspaceContentSearchResult> {
    const generation = getRuntimeEndpointGeneration();
    try {
      const response = await runtimeFetch('/api/workspace/search/content', {
        method: 'POST',
        headers: {
          Accept: 'application/x-ndjson, application/json',
          'Content-Type': 'application/json',
          'x-piarium-generation': String(generation),
        },
        body: JSON.stringify(request),
        signal: options?.signal,
      });
      if (options?.signal?.aborted) {
        return { status: 'cancelled', generation };
      }
      assertGeneration(generation);
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: response.statusText })) as {
          error?: string;
          reason?: unknown;
          status?: string;
          message?: string;
          generation?: number;
        };
        if (error.status === 'failure' && typeof error.message === 'string') {
          return { status: 'failure', generation, message: error.message };
        }
        throw new WorkspaceSearchError(error.error || 'Workspace search failed', {
          reason: parseWorkspaceSearchFailureReason(error.reason),
          status: response.status,
        });
      }
      if (response.headers.get('content-type')?.includes('application/x-ndjson')) {
        return await readNdjsonSearch(response, generation, options?.onBatch);
      }
      const payload = await response.json() as WorkspaceContentSearchResult;
      if (!payload || typeof payload !== 'object' || typeof payload.status !== 'string') {
        throw new WorkspaceSearchError('Workspace search returned an invalid response', { reason: 'failed' });
      }
      return payload;
    } catch (error) {
      if (options?.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return { status: 'cancelled', generation };
      }
      throw error;
    }
  },
});
