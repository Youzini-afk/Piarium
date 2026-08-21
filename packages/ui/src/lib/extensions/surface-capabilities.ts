import { SurfaceCapabilityRegistry } from '@piarium/extension-surface';
import type { JsonObject, JsonValue } from '@piarium/extension-contract';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { getDocumentRegistry } from '@/lib/documents/session';
import type { DocumentIdentity, DocumentRecord } from '@/lib/documents/types';

const object = (value: JsonValue, label: string): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
};

const identityFrom = (value: JsonValue): DocumentIdentity => {
  const input = object(value, 'resource');
  if (typeof input.workspaceId !== 'string' || !input.workspaceId) {
    throw new TypeError('resource.workspaceId must be a non-empty string');
  }
  if (typeof input.resourceId !== 'string' || !input.resourceId) {
    throw new TypeError('resource.resourceId must be a non-empty string');
  }
  return { workspaceId: input.workspaceId, resourceId: input.resourceId };
};

const serializeRecord = (record: DocumentRecord): JsonObject => ({
  status: record.status,
  resource: record.identity,
  content: record.buffer,
  revision: record.baseRevision,
  documentVersion: record.localEditRevision,
  dirty: record.dirty,
  saving: record.saving,
  encoding: record.encoding,
  bom: record.bom,
  byteLength: record.byteLength,
  ...(record.errorMessage ? { message: record.errorMessage } : {}),
});

const documentCapability = async (method: string, value: JsonValue): Promise<JsonValue> => {
  const params = object(value, 'workspace.documents request');
  const documents = getRegisteredRuntimeAPIs()?.documents;
  if (!documents) throw new Error('Workspace documents are unavailable');
  if (method === 'resolveWorkspace') {
    return structuredClone(await documents.resolveWorkspace(params)) as unknown as JsonValue;
  }
  if (method === 'move') {
    return structuredClone(await documents.move(params as never)) as unknown as JsonValue;
  }
  if (method === 'delete') {
    return structuredClone(await documents.delete(params as never)) as unknown as JsonValue;
  }
  if (method !== 'read' && method !== 'write') {
    throw new Error(`workspace.documents does not implement ${method}`);
  }

  const identity = identityFrom(params.resource ?? params);
  const registry = getDocumentRegistry();
  const current = await registry.open(identity);
  if (method === 'read') return serializeRecord(current);
  if (typeof params.content !== 'string') throw new TypeError('content must be a string');
  const expectedRevision = params.expectedRevision === null || typeof params.expectedRevision === 'string'
    ? params.expectedRevision
    : undefined;
  const expectedDocumentVersion = Number.isSafeInteger(params.expectedDocumentVersion)
    ? Number(params.expectedDocumentVersion)
    : undefined;
  if (
    expectedRevision === undefined
    || expectedRevision !== current.baseRevision
    || (expectedDocumentVersion !== undefined && expectedDocumentVersion !== current.localEditRevision)
    || (expectedDocumentVersion === undefined && current.dirty)
  ) {
    return { status: 'conflict', current: serializeRecord(current) };
  }
  if (current.status === 'missing') {
    const created = await registry.create(identity, params.content);
    return {
      status: created.status === 'missing' ? 'conflict' : 'written',
      revision: created.baseRevision,
      documentVersion: created.localEditRevision,
      byteLength: created.byteLength,
    };
  }
  registry.applyTransaction(identity, params.content, { origin: 'isolated-editor' });
  const saved = await registry.save(identity);
  if (saved.status === 'conflict' || saved.status === 'deleted') {
    return { status: 'conflict', current: serializeRecord(saved) };
  }
  return {
    status: 'written',
    revision: saved.baseRevision,
    documentVersion: saved.localEditRevision,
    byteLength: saved.byteLength,
  };
};

export const surfaceCapabilityRegistry = new SurfaceCapabilityRegistry();

surfaceCapabilityRegistry.register({
  exposure: 'remote-safe',
  id: 'workspace.documents',
  projectTrust: 'required',
  supports: ['desktop', 'mobile', 'vscode', 'web'],
}, documentCapability);
