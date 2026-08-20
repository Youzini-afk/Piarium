import type {
  WorkspaceContentSearchRequest,
  WorkspaceContentSearchResult,
  WorkspaceSearchAPI,
} from '@piarium/ui/lib/api/types';
import { WorkspaceSearchError, parseWorkspaceSearchFailureReason } from '@piarium/ui/lib/api/search-errors';
import { runtimeFetch } from '@piarium/ui/lib/runtime-fetch';
import { getRuntimeEndpointGeneration } from '@piarium/ui/lib/runtime-switch';

const assertGeneration = (generation: number): void => {
  if (generation !== getRuntimeEndpointGeneration()) {
    throw new WorkspaceSearchError('Application host endpoint changed', { reason: 'stale-completion' });
  }
};

export const createWebWorkspaceSearchAPI = (): WorkspaceSearchAPI => ({
  async searchContent(request: WorkspaceContentSearchRequest, options): Promise<WorkspaceContentSearchResult> {
    const generation = getRuntimeEndpointGeneration();
    try {
      const response = await runtimeFetch('/api/workspace/search/content', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
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
