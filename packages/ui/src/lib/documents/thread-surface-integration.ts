import type { ThreadSurfaceEdit, ThreadSurfaceParent } from '@piarium/protocol';
import { getDocumentRegistry } from './session';
import type { DocumentRegistry } from './registry';
import type { DocumentIdentity } from './types';

const endPosition = (content: string): { line: number; character: number } => {
  const lines = content.split('\n');
  return { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 };
};

export const collectSurfaceParents = (
  workspaceId: string,
  resourceIds: readonly string[],
  registry: Pick<DocumentRegistry, 'get'> = getDocumentRegistry(),
): ThreadSurfaceParent[] => {
  const parents: ThreadSurfaceParent[] = [];
  for (const resourceId of resourceIds) {
    const record = registry.get({ workspaceId, resourceId });
    if (!record || record.status !== 'ready') continue;
    parents.push({
      resourceId,
      localEditRevision: record.localEditRevision,
      baseRevision: record.baseRevision,
      content: record.buffer,
    });
  }
  return parents;
};

export const applyThreadSurfaceEdits = async (input: {
  workspaceId: string;
  operationId: string;
  edits: readonly ThreadSurfaceEdit[];
  registry?: Pick<DocumentRegistry, 'get' | 'open' | 'prepareWorkspaceEdit' | 'applyWorkspaceEdit'>;
}): Promise<{ applied: string[]; failed: Array<{ path: string; reason: string }> }> => {
  const registry = input.registry ?? getDocumentRegistry();
  if (input.edits.length === 0) return { applied: [], failed: [] };
  const loaded: Array<{ edit: ThreadSurfaceEdit; buffer: string }> = [];
  const failed: Array<{ path: string; reason: string }> = [];
  for (const edit of input.edits) {
    const identity: DocumentIdentity = { workspaceId: input.workspaceId, resourceId: edit.resourceId };
    const record = registry.get(identity) ?? await registry.open(identity);
    if (record.status !== 'ready') {
      failed.push({ path: edit.resourceId, reason: `Document is ${record.status}` });
      continue;
    }
    if (record.localEditRevision !== edit.expectedLocalEditRevision) {
      failed.push({
        path: edit.resourceId,
        reason: `Document revision changed from ${edit.expectedLocalEditRevision} to ${record.localEditRevision}`,
      });
      continue;
    }
    loaded.push({ edit, buffer: record.buffer });
  }
  if (failed.length > 0) return { applied: [], failed };
  const prepared = await registry.prepareWorkspaceEdit({
    workspaceId: input.workspaceId,
    origin: 'thread-integration',
    groupId: input.operationId,
    textEdits: loaded.map(({ edit, buffer }) => ({
      identity: { workspaceId: input.workspaceId, resourceId: edit.resourceId },
      version: edit.expectedLocalEditRevision,
      edits: [{
        range: { start: { line: 0, character: 0 }, end: endPosition(buffer) },
        newText: edit.newText,
      }],
    })),
  });
  if (prepared.status === 'rejected') {
    return {
      applied: [],
      failed: prepared.failures.map((failure) => ({
        path: failure.identity?.resourceId ?? input.workspaceId,
        reason: failure.message,
      })),
    };
  }
  const committed = await registry.applyWorkspaceEdit(prepared.groupId);
  if (committed.status !== 'applied') {
    return {
      applied: [],
      failed: committed.failures.map((failure) => ({
        path: failure.identity?.resourceId ?? input.workspaceId,
        reason: failure.message,
      })),
    };
  }
  return {
    applied: input.edits.map((edit) => edit.resourceId),
    failed: [],
  };
};
