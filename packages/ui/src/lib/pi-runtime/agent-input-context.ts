import type { AgentInputContext } from '@piarium/protocol';
import { getDocumentRegistry } from '@/lib/documents/session';

export const captureSurfaceAgentInputContext = async (
  sessionId: string,
  workspaceId: string,
): Promise<AgentInputContext> => {
  try {
    return await getDocumentRegistry().captureAgentInputContext(sessionId, workspaceId);
  } catch {
    return {
      source: 'surface',
      workspaceId,
      dirtyPaths: [],
      snapshot: { status: 'unavailable', reason: 'surface-unavailable' },
    };
  }
};

export const releaseSurfaceAgentInputContext = async (
  sessionId: string,
  context: AgentInputContext,
): Promise<void> => {
  if (context.source !== 'surface' || context.snapshot.status !== 'ready') return;
  try {
    await getDocumentRegistry().releaseAgentInputContext(sessionId, context);
  } catch {
    // SessionHost may already have committed or released the pending snapshot.
  }
};
