import type {
  CheckpointCleanupResult,
  CheckpointRecord,
  CheckpointRestoreResult,
  CheckpointRestoreReviewResult,
  CheckpointStorageStats,
  CheckpointsAPI,
} from '@openchamber/ui/lib/api/types';
import { sendBridgeMessage, sendBridgeMessageWithOptions } from './bridge';

const normalizePath = (value: string): string => value.replace(/\\/g, '/');

type CheckpointResponse = {
  checkpoint?: CheckpointRecord | null;
};

export const createVSCodeCheckpointsAPI = (): CheckpointsAPI => ({
  async create(input) {
    const data = await sendBridgeMessageWithOptions<CheckpointResponse>('api:checkpoint/create', {
      ...input,
      directory: normalizePath(input.directory),
    }, { timeoutMs: 300000 });
    return data?.checkpoint ?? null;
  },

  async getForMessage(input) {
    const data = await sendBridgeMessage<CheckpointResponse>('api:checkpoint/get-for-message', {
      ...input,
      directory: input.directory ? normalizePath(input.directory) : undefined,
    });
    return data?.checkpoint ?? null;
  },

  async list(sessionId) {
    const data = await sendBridgeMessage<{ checkpoints?: CheckpointRecord[] }>('api:checkpoint/list', { sessionId });
    return Array.isArray(data?.checkpoints) ? data.checkpoints : [];
  },

  async diff(input) {
    const data = await sendBridgeMessageWithOptions<{ files?: Array<{ path: string; type: 'added' | 'modified' | 'deleted' }> }>(
      'api:checkpoint/diff',
      input,
      { timeoutMs: 300000 },
    );
    return { files: Array.isArray(data?.files) ? data.files : [] };
  },

  async openFileDiff(input) {
    await sendBridgeMessage('api:checkpoint/open-file-diff', input);
  },

  async reviewRestore(input): Promise<CheckpointRestoreReviewResult> {
    const data = await sendBridgeMessageWithOptions<CheckpointRestoreReviewResult>(
      'api:checkpoint/review-restore',
      input,
      { timeoutMs: 0 },
    );
    return {
      restore: Boolean(data?.restore),
      cancelled: Boolean(data?.cancelled),
      changedCount: typeof data?.changedCount === 'number' ? data.changedCount : 0,
      openedDiff: Boolean(data?.openedDiff),
    };
  },

  async restore(input): Promise<CheckpointRestoreResult> {
    const data = await sendBridgeMessageWithOptions<CheckpointRestoreResult>(
      'api:checkpoint/restore',
      input,
      { timeoutMs: 300000 },
    );
    return {
      success: Boolean(data?.success),
      restored: typeof data?.restored === 'number' ? data.restored : 0,
      deleted: typeof data?.deleted === 'number' ? data.deleted : 0,
      skipped: typeof data?.skipped === 'number' ? data.skipped : 0,
      safetyCheckpoint: data?.safetyCheckpoint,
    };
  },

  async stats(): Promise<CheckpointStorageStats> {
    const data = await sendBridgeMessage<CheckpointStorageStats>('api:checkpoint/stats');
    return {
      sessionCount: typeof data?.sessionCount === 'number' ? data.sessionCount : 0,
      checkpointCount: typeof data?.checkpointCount === 'number' ? data.checkpointCount : 0,
      totalBytes: typeof data?.totalBytes === 'number' ? data.totalBytes : 0,
      retentionLimit: typeof data?.retentionLimit === 'number' ? data.retentionLimit : 200,
    };
  },

  async cleanupSession(sessionId): Promise<CheckpointCleanupResult> {
    return sendBridgeMessage<CheckpointCleanupResult>('api:checkpoint/cleanup-session', { sessionId });
  },

  async cleanupRetention(limit): Promise<CheckpointCleanupResult> {
    return sendBridgeMessageWithOptions<CheckpointCleanupResult>(
      'api:checkpoint/cleanup-retention',
      { limit },
      { timeoutMs: 300000 },
    );
  },

  async cleanupAll(): Promise<CheckpointCleanupResult> {
    return sendBridgeMessageWithOptions<CheckpointCleanupResult>(
      'api:checkpoint/cleanup-all',
      undefined,
      { timeoutMs: 300000 },
    );
  },
});
