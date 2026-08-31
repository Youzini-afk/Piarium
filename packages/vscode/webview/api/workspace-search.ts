import type {
  WorkspaceContentSearchRequest,
  WorkspaceContentSearchResult,
  WorkspaceSearchAPI,
} from '@piarium/application-client';
import { WorkspaceSearchError } from '@piarium/application-client';
import { getRuntimeEndpointGeneration } from '@piarium/ui/lib/runtime-switch';
import { sendBridgeMessageWithOptions } from './bridge';

export const createVSCodeWorkspaceSearchAPI = (): WorkspaceSearchAPI => ({
  async searchContent(request: WorkspaceContentSearchRequest, options): Promise<WorkspaceContentSearchResult> {
    const generation = getRuntimeEndpointGeneration();
    try {
      const payload = await sendBridgeMessageWithOptions<WorkspaceContentSearchResult>(
        'api:workspace:search-content',
        { ...request, generation },
        { signal: options?.signal },
      );
      if (!payload || typeof payload !== 'object' || typeof payload.status !== 'string') {
        throw new WorkspaceSearchError('Workspace search returned an invalid response', { reason: 'failed' });
      }
      if (generation !== getRuntimeEndpointGeneration()) {
        throw new WorkspaceSearchError('Application host endpoint changed', { reason: 'stale-completion' });
      }
      return payload;
    } catch (error) {
      if (error instanceof WorkspaceSearchError) throw error;
      if (options?.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return { status: 'cancelled', generation };
      }
      const message = error instanceof Error ? error.message : 'Workspace search failed';
      return { status: 'failure', generation, message };
    }
  },
});
