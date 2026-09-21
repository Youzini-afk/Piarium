import { createHash } from 'node:crypto';
import type { SettingsActionOperationStore, SettingsServiceCaller } from './settings-service.js';
import type { KernelStorageAdapter } from '../kernel/storage-adapter.js';

type OperationState = NonNullable<import('@varin/protocol').SettingsActionResult['operation']>['state'];

interface StoredOperation {
  id: string;
  workspaceId: string;
  sessionId: string;
  entryId: string;
  verb: string;
  state: OperationState;
  detail?: string;
  cancelVerb?: string;
  createdAt: string;
  updatedAt: string;
}

const recordIdFor = (caller: SettingsServiceCaller, entryId: string, operationId: string): string => (
  `settings.operation:${createHash('sha256').update(`${caller.sessionId}\0${entryId}\0${operationId}`).digest('hex')}`
);

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const parse = (value: unknown): StoredOperation | null => {
  const row = asRecord(value);
  const state = row.state;
  if (typeof row.id !== 'string' || typeof row.workspaceId !== 'string' || typeof row.sessionId !== 'string'
    || typeof row.entryId !== 'string' || typeof row.verb !== 'string'
    || (state !== 'running' && state !== 'succeeded' && state !== 'failed' && state !== 'cancelled' && state !== 'unavailable')
    || typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string') return null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    entryId: row.entryId,
    verb: row.verb,
    state,
    ...(typeof row.detail === 'string' ? { detail: row.detail } : {}),
    ...(typeof row.cancelVerb === 'string' ? { cancelVerb: row.cancelVerb } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

const parsePayload = (value: string | undefined): unknown => {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
};

/**
 * Durable settings operation metadata on the existing Rust typed record port.
 * The kernel owns the `settings.operation` envelope; this store does not create
 * a second database or claim ownership of the domain action itself.
 */
export function createKernelSettingsActionOperationStore(
  adapter: KernelStorageAdapter,
): SettingsActionOperationStore {
  const contextFor = async (caller: SettingsServiceCaller) => {
    if (!caller.workspaceId || !caller.sessionId) return null;
    return adapter.context(caller.workspaceId, 'settings-action', {
      sessionId: caller.sessionId,
      owningWorkspace: caller.workspaceId,
      executionWorkspace: caller.workspaceId,
    });
  };

  return {
    async get(caller, entryId, operationId) {
      const context = await contextFor(caller);
      if (!context) return null;
      const record = await context.records.get(recordIdFor(caller, entryId, operationId));
      const parsed = parse(parsePayload(record?.payloadJson));
      if (!parsed || parsed.workspaceId !== caller.workspaceId || parsed.sessionId !== caller.sessionId) return null;
      return {
        id: parsed.id,
        entryId: parsed.entryId,
        verb: parsed.verb,
        state: parsed.state,
        ...(parsed.detail ? { detail: parsed.detail } : {}),
        ...(parsed.cancelVerb ? { cancelVerb: parsed.cancelVerb } : {}),
        ...(typeof record?.recordRevision === 'number' ? { recordRevision: record.recordRevision } : {}),
      };
    },
    async available(caller) {
      const context = await contextFor(caller);
      if (!context) return false;
      try {
        // A read through the same typed record authority confirms that the
        // caller has a usable workspace/session record context before invoke.
        await context.records.list({ recordType: 'settings.operation' });
        return true;
      } catch {
        return false;
      }
    },
    async put(caller, operation) {
      const context = await contextFor(caller);
      if (!context) throw new Error('durable settings operation storage requires a workspace-bound session');
      const operationRecordId = recordIdFor(caller, operation.entryId, operation.id);
      const existing = await context.records.get(operationRecordId);
      const previous = parse(existing ? parsePayload(existing.payloadJson) : null);
      if (previous && (previous.workspaceId !== caller.workspaceId || previous.sessionId !== caller.sessionId)) {
        throw new Error('settings operation belongs to a different session');
      }
      const now = new Date().toISOString();
      const payload: StoredOperation = {
        id: operation.id,
        workspaceId: caller.workspaceId!,
        sessionId: caller.sessionId,
        entryId: operation.entryId,
        verb: operation.verb,
        state: operation.state,
        ...(operation.detail ? { detail: operation.detail } : {}),
        ...(operation.cancelVerb ? { cancelVerb: operation.cancelVerb } : {}),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      await context.records.put({
        operationId: `settings-action-record:${operation.id}:${now}`,
        recordId: operationRecordId,
        recordType: 'settings.operation',
        state: operation.state,
        payloadJson: JSON.stringify(payload),
        sessionId: caller.sessionId,
        ...(typeof existing?.recordRevision === 'number' ? { expectedRecordRevision: existing.recordRevision } : {}),
      });
    },
  };
}
