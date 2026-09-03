import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseWorkspaceCombinedRecoveryPlan,
  parseRecoveryRetentionPolicy,
  parseRecoveryStorageMoveOperation,
  parseWorkspaceRecoveryCheckpointSummary,
  parseWorkspaceRecoveryFailure,
  parseWorkspaceRecoveryTurnBinding,
  type RecoveryRetentionPolicy,
  type RecoveryRetentionPolicyInput,
  type RecoveryRetentionStatus,
  type RecoveryStorageCleanupInput,
  type RecoveryStorageCleanupOperationResult,
  type RecoveryStorageCleanupResult,
  type RecoveryStorageLocation,
  type RecoveryStorageMoveOperation,
  type RecoveryStorageMoveResult,
  type RecoveryStorageStatus,
  type RecoveryStorageStatusResult,
  type RecoveryStorageWorkspaceSummary,
  type RecoveryStorageWorkspaceListResult,
  type RecoveryRetentionStatusResult,
  type WorkspaceCombinedRecoveryApplyInput,
  type WorkspaceCombinedRecoveryCoverage,
  type WorkspaceCombinedRecoveryListResult,
  type WorkspaceCombinedRecoveryOperation,
  type WorkspaceCombinedRecoveryOperationResult,
  type WorkspaceCombinedRecoveryOperationState,
  type WorkspaceCombinedRecoveryPlan,
  type WorkspaceCombinedRecoveryPrepareInput,
  type WorkspaceCombinedRecoveryPrepareResult,
  type WorkspaceRecoveryCheckpointInput,
  type WorkspaceRecoveryCheckpointListResult,
  type WorkspaceRecoveryCheckpointQuery,
  type WorkspaceRecoveryCheckpointResult,
  type WorkspaceRecoveryCheckpointSummary,
  type WorkspaceRecoveryConflict,
  type WorkspaceRecoveryEntryTarget,
  type WorkspaceRecoveryEntryBindingResult,
  type WorkspaceRecoveryFailure,
  type WorkspaceRecoveryFailureCode,
  type WorkspaceRecoveryFailedResult,
  type WorkspaceRecoveryMutationAfterInput,
  type WorkspaceRecoveryMutationBeforeInput,
  type WorkspaceRecoveryMutationResult,
  type WorkspaceRecoveryStatusResult,
  type WorkspaceRecoveryTurnBinding,
  type WorkspaceRecoveryTurnBindingResult,
  type WorkspaceRecoveryTurnSettledInput,
  type WorkspaceRecoveryTurnStartInput,
  type WorkspaceRecoveryUncoveredPath,
  type SetRecoveryStorageLocationInput,
} from '@piarium/extension-contract';
import {
  type BindingRow,
  type ChangeRow,
  type CheckpointRow,
  type OperationFilePhase,
  type OperationFileRow,
  type OperationData,
  type OperationRow,
  type SqliteDatabase,
  bindingFromRow,
  changeFromRow,
  checkpointFromRow,
  deleteObjectReferences,
  initOperationFiles,
  inspectRecoveryJournalCatalog,
  openRecoveryJournalCatalog,
  operationFileRows,
  operationFromRow,
  rebuildObjectReferences,
  replaceObjectReferences,
  updateOperationFilePhase,
  verifyRecoveryJournalStore,
  writeOperationRow,
} from './journal-catalog.js';
import { failedRecoveryResult, RecoveryPrimitiveError, recoveryFailure } from './errors.js';
import {
  createRecoveryFileStore,
  normalizeResourceId,
  parseRecoveryState,
  sameState,
  stateIdentity,
  statTree,
  type RecoveryFileStore,
  type RecoveryIdentity,
  type RecoveryState,
} from './journal-files.js';
import {
  createRecoveryLocationRegistry,
  readRecoveryJsonAtomic,
  writeRecoveryJsonAtomic,
  type RecoveryLocationRegistry,
} from './locations.js';
import { createRecoveryWorkspaceLeaseManager } from './workspace-lease.js';

type FsPromises = typeof fs.promises;
type PathModule = typeof path;

interface WorkspaceRegistration {
  canonicalPath: string;
  workspaceId: string;
}

interface DirtyBufferResource {
  baseRevision: string | null;
  localEditRevision: number;
  resource: { resourceId: string; workspaceId: string };
}

interface DirtyBufferPublication {
  generation: number;
  ownerId: string;
  resources: DirtyBufferResource[];
  updatedAt: string;
  workspaceId: string;
}

interface DirtyBarrierHandle {
  release(): Promise<void>;
  settle(): Promise<void>;
}

interface RecoveryDocumentsAuthority {
  beginDirtyStateBarrier?: (
    workspaceId: string,
    paths: string[],
    options: { caseSensitive: boolean },
  ) => Promise<DirtyBarrierHandle>;
  inspectDirtyBuffers(workspaceId: string): Promise<DirtyBufferPublication[]>;
  inspectWorkspace(workspaceId: string): Promise<{ root: string; workspaceId: string }>;
  listWorkspaceRegistrations(): Promise<WorkspaceRegistration[]>;
}

interface NavigationPrepared {
  editorImages?: WorkspaceCombinedRecoveryOperation['editorImages'] | undefined;
  editorText?: string | undefined;
  expectedLeafId: string | null;
  removedEntryIds?: string[] | undefined;
  targetLeafId: string | null;
}

interface NavigationCommitted {
  editorImages?: WorkspaceCombinedRecoveryOperation['editorImages'] | undefined;
  editorText?: string | undefined;
  markerId?: string | undefined;
  navigationMarkerId?: string | undefined;
}

export interface RecoverySessionNavigation {
  commit(input: {
    entryId: string;
    expectedLeafId: string | null;
    operationId: string;
    preparedTargetLeafId: string | null;
    sessionId: string;
    workspaceId: string;
  }): Promise<NavigationCommitted>;
  commitLeaf(input: {
    expectedLeafId: string | null;
    operationId: string;
    preparedTargetLeafId: string | null;
    sessionId: string;
    workspaceId: string;
  }): Promise<NavigationCommitted>;
  prepare(input: WorkspaceCombinedRecoveryPrepareInput): Promise<NavigationPrepared>;
  prepareLeaf(input: {
    sessionId: string;
    targetLeafId: string | null;
    workspaceId: string;
  }): Promise<NavigationPrepared>;
}

export interface CreateWorkspaceRecoveryEngineOptions {
  authorityId: string;
  dataDir: string;
  defaultRecoveryDir?: string | undefined;
  documents: RecoveryDocumentsAuthority;
  fileStore?: RecoveryFileStore | undefined;
  fsModule?: typeof fs | undefined;
  fsPromises?: FsPromises | undefined;
  pathModule?: PathModule | undefined;
  sessionNavigation: RecoverySessionNavigation;
  storageOwnerId?: string | undefined;
}

interface RecoveryTargetStates {
  expected: RecoveryState;
  target: RecoveryState;
}

type RecoveryTargets = Record<string, RecoveryTargetStates>;

interface CombinedOperationRecord extends OperationData {
  appliedPaths: string[];
  conversationState: WorkspaceCombinedRecoveryOperation['conversationState'];
  createdAt: string;
  editorImages?: WorkspaceCombinedRecoveryOperation['editorImages'] | undefined;
  editorText?: string | undefined;
  failure: WorkspaceRecoveryFailure | null;
  fileState: WorkspaceCombinedRecoveryOperation['fileState'];
  id: string;
  navigationMarkerId: string | null;
  plan: WorkspaceCombinedRecoveryPlan;
  safety: Record<string, RecoveryState>;
  state: WorkspaceCombinedRecoveryOperationState;
  targets: RecoveryTargets;
  updatedAt: string;
  workspaceId: string;
}

interface BindingFailureOptions {
  code?: WorkspaceRecoveryFailureCode | undefined;
  origin?: WorkspaceRecoveryFailure['origin'] | undefined;
  reason?: string | undefined;
  retryable?: boolean | undefined;
}

interface WorkspaceLeaseOptions {
  mode: 'exclusive' | 'shared';
  purpose: string;
}

interface LocatedOperation {
  identity: RecoveryIdentity;
  record: CombinedOperationRecord;
  root: string;
}

interface SequencedRecoveryChange {
  after: RecoveryState;
  before: RecoveryState;
  checkpointId: string;
  mutationId: string;
  path: string;
  sequence: number;
  toolName: string;
}

type MoveOperation = RecoveryStorageMoveOperation;

export interface WorkspaceRecoveryEngine {
  locations: RecoveryLocationRegistry;
  applyCombinedRecovery(input: WorkspaceCombinedRecoveryApplyInput): Promise<WorkspaceCombinedRecoveryOperationResult>;
  cancelCombinedOperation(operationId: string): Promise<WorkspaceCombinedRecoveryOperationResult>;
  clearStorageLocationOverride(workspaceId: string): Promise<RecoveryStorageMoveResult>;
  cleanupStorage(input: RecoveryStorageCleanupInput): Promise<RecoveryStorageCleanupOperationResult>;
  createCheckpoint(input: WorkspaceRecoveryCheckpointInput): Promise<WorkspaceRecoveryCheckpointResult>;
  deleteWorkspaceHistory(workspaceId: string): Promise<RecoveryStorageCleanupOperationResult>;
  fenceUnfinishedOperations(): Promise<WorkspaceCombinedRecoveryOperation[]>;
  getCombinedOperation(operationId: string): Promise<WorkspaceCombinedRecoveryOperationResult>;
  getStorageMove(operationId: string): Promise<RecoveryStorageMoveResult>;
  listCheckpoints(input: WorkspaceRecoveryCheckpointQuery): Promise<WorkspaceRecoveryCheckpointListResult>;
  listCombinedOperations(workspaceId: string): Promise<WorkspaceCombinedRecoveryListResult>;
  listStorageWorkspaces(): Promise<RecoveryStorageWorkspaceListResult>;
  prepareCombinedRecovery(input: WorkspaceCombinedRecoveryPrepareInput): Promise<WorkspaceCombinedRecoveryPrepareResult>;
  prepareCombinedUndo(operationId: string): Promise<WorkspaceCombinedRecoveryPrepareResult>;
  recordMutationAfter(input: WorkspaceRecoveryMutationAfterInput): Promise<WorkspaceRecoveryMutationResult>;
  recordMutationBefore(input: WorkspaceRecoveryMutationBeforeInput): Promise<WorkspaceRecoveryMutationResult>;
  recordTurnSettled(input: WorkspaceRecoveryTurnSettledInput): Promise<WorkspaceRecoveryTurnBindingResult>;
  recordTurnStart(input: WorkspaceRecoveryTurnStartInput): Promise<WorkspaceRecoveryTurnBindingResult>;
  retentionStatus(workspaceId: string): Promise<RecoveryRetentionStatusResult>;
  resolveEntry(input: WorkspaceRecoveryEntryTarget): Promise<WorkspaceRecoveryEntryBindingResult>;
  resumeCombinedOperations(): Promise<WorkspaceCombinedRecoveryOperation[]>;
  resumeWorkspaceOperations(): Promise<never[]>;
  setDefaultStorageLocation(location: RecoveryStorageLocation): Promise<RecoveryStorageStatusResult>;
  setRetentionPolicy(input: RecoveryRetentionPolicyInput): Promise<RecoveryRetentionStatusResult>;
  setStorageLocation(input: SetRecoveryStorageLocationInput): Promise<RecoveryStorageMoveResult>;
  status(workspaceId: string): Promise<WorkspaceRecoveryStatusResult>;
  storageStatus(workspaceId?: string): Promise<RecoveryStorageStatusResult>;
  dispose(): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const errorCode = (error: unknown): string | undefined => (
  isRecord(error) && typeof error.code === 'string' ? error.code : undefined
);

const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new RecoveryPrimitiveError('storage-malformed', `${label} is malformed`, { origin: 'storage' });
  }
  return value;
};

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== 'string') {
    throw new RecoveryPrimitiveError('storage-malformed', `${label} is malformed`, { origin: 'storage' });
  }
  return value;
};

const parseStateRecord = (value: unknown, label: string): Record<string, RecoveryState> => {
  const record = requireRecord(value, label);
  return Object.fromEntries(Object.entries(record).map(([relativePath, state]) => [
    relativePath,
    parseRecoveryState(state),
  ]));
};

const parseTargets = (value: unknown): RecoveryTargets => {
  const record = requireRecord(value, 'Recovery operation targets');
  return Object.fromEntries(Object.entries(record).map(([relativePath, rawStates]) => {
    const states = requireRecord(rawStates, `Recovery target ${relativePath}`);
    return [relativePath, {
      expected: parseRecoveryState(states.expected),
      target: parseRecoveryState(states.target),
    }];
  }));
};

const parseCombinedOperationRecord = (row: OperationRow): CombinedOperationRecord => {
  const raw = operationFromRow(row);
  const plan = parseWorkspaceCombinedRecoveryPlan(raw.plan);
  const state = requireString(raw.state, 'Recovery operation state') as WorkspaceCombinedRecoveryOperationState;
  const allowedStates: readonly WorkspaceCombinedRecoveryOperationState[] = [
    'planned', 'applying-files', 'files-restored', 'navigating-conversation',
    'compensating-files', 'compensated', 'complete', 'aborted', 'needs-attention',
  ];
  if (!allowedStates.includes(state)) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery operation state is malformed', { origin: 'storage' });
  }
  const appliedPaths = Array.isArray(raw.appliedPaths) && raw.appliedPaths.every((entry) => typeof entry === 'string')
    ? [...raw.appliedPaths] as string[]
    : (() => { throw new RecoveryPrimitiveError('storage-malformed', 'Recovery applied paths are malformed', { origin: 'storage' }); })();
  const conversationState = raw.conversationState;
  if (conversationState !== 'unchanged' && conversationState !== 'navigated' && conversationState !== 'diverged') {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery conversation state is malformed', { origin: 'storage' });
  }
  const fileState = raw.fileState;
  if (fileState !== 'unchanged' && fileState !== 'restored' && fileState !== 'compensated' && fileState !== 'needs-attention') {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery file state is malformed', { origin: 'storage' });
  }
  const createdAt = requireString(raw.createdAt, 'Recovery operation creation time');
  const updatedAt = requireString(raw.updatedAt, 'Recovery operation update time');
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery operation timestamp is malformed', { origin: 'storage' });
  }
  if (plan.id !== raw.id || plan.workspaceId !== raw.workspaceId) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery operation identity is inconsistent', { origin: 'storage' });
  }
  const failure = raw.failure === null || raw.failure === undefined
    ? null
    : parseWorkspaceRecoveryFailure(raw.failure);
  const navigationMarkerId = raw.navigationMarkerId === null || raw.navigationMarkerId === undefined
    ? null
    : requireString(raw.navigationMarkerId, 'Recovery navigation marker');
  const editorImages = raw.editorImages === undefined
    ? undefined
    : requireRecord({ value: raw.editorImages }, 'Recovery editor images').value;
  if (editorImages !== undefined && (!Array.isArray(editorImages) || editorImages.some((entry) => (
    !isRecord(entry) || typeof entry.data !== 'string' || typeof entry.mimeType !== 'string'
  )))) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery editor images are malformed', { origin: 'storage' });
  }
  if (raw.editorText !== undefined && typeof raw.editorText !== 'string') {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery editor text is malformed', { origin: 'storage' });
  }
  return {
    appliedPaths,
    conversationState,
    createdAt,
    failure,
    fileState,
    id: raw.id,
    navigationMarkerId,
    plan,
    safety: parseStateRecord(raw.safety ?? {}, 'Recovery safety states'),
    state,
    targets: parseTargets(raw.targets),
    updatedAt,
    workspaceId: raw.workspaceId,
    ...(editorImages === undefined ? {} : { editorImages: editorImages as NonNullable<WorkspaceCombinedRecoveryOperation['editorImages']> }),
    ...(typeof raw.editorText === 'string' ? { editorText: raw.editorText } : {}),
  };
};

const parseBindingRow = (row: BindingRow): WorkspaceRecoveryTurnBinding => (
  parseWorkspaceRecoveryTurnBinding(bindingFromRow(row))
);

const parseCheckpointRow = (row: CheckpointRow): WorkspaceRecoveryCheckpointSummary => (
  parseWorkspaceRecoveryCheckpointSummary(checkpointFromRow(row))
);

const parseChangeRow = (row: ChangeRow) => {
  const change = changeFromRow(row);
  return {
    ...change,
    after: change.after === null ? null : parseRecoveryState(change.after),
    before: parseRecoveryState(change.before),
  };
};

const targetStatesFor = (record: CombinedOperationRecord, relativePath: string): RecoveryTargetStates => {
  const states = record.targets[relativePath];
  if (!states) {
    throw new RecoveryPrimitiveError('storage-malformed', `Recovery target is missing: ${relativePath}`, {
      origin: 'storage',
    });
  }
  return states;
};

const safetyStateFor = (record: CombinedOperationRecord, relativePath: string): RecoveryState => {
  const state = record.safety[relativePath];
  if (!state) {
    throw new RecoveryPrimitiveError('storage-malformed', `Recovery safety state is missing: ${relativePath}`, {
      origin: 'storage',
    });
  }
  return state;
};

const stateByteLength = (state: RecoveryState): number => (
  state.kind === 'regular-file' ? state.byteLength : 0
);

const stateObjectHash = (state: RecoveryState): string | undefined => (
  state.kind === 'regular-file' ? state.objectHash : undefined
);

const IGNORED_WATCH_PATH = /\.piarium-(?:tmp|restore|recovery)-/;
const TERMINAL_STATES = new Set(['complete', 'aborted', 'compensated', 'needs-attention']);
const PRUNABLE_OPERATION_STATES = new Set(['complete', 'aborted', 'compensated']);
const DEFAULT_RETENTION_POLICY: Readonly<RecoveryRetentionPolicy> = Object.freeze({
  maxAgeDays: null,
  maxByteLength: null,
  maxCheckpointCount: null,
  maxOperationCount: null,
});
const retentionPolicyKey = (workspaceId: string): string => `retention_policy:${workspaceId}`;
const retentionRunKey = (workspaceId: string): string => `retention_last_run:${workspaceId}`;

const operationRevision = (value: unknown): string => `sha256-${createHash('sha256')
  .update(JSON.stringify(value))
  .digest('hex')}`;

const publicOperation = (record: CombinedOperationRecord): WorkspaceCombinedRecoveryOperation => ({
  affectedPathCount: record.plan.affectedPaths.length,
  appliedPathCount: record.appliedPaths.length,
  conversationState: record.conversationState,
  createdAt: record.createdAt,
  entryId: record.plan.entryId,
  expectedLeafId: record.plan.expectedLeafId,
  fileState: record.fileState,
  id: record.id,
  revision: record.plan.revision,
  sessionId: record.plan.sessionId,
  state: record.state,
  targetLeafId: record.plan.targetLeafId,
  updatedAt: record.updatedAt,
  workspaceId: record.plan.workspaceId,
  ...(record.editorImages ? { editorImages: record.editorImages } : {}),
  ...(record.editorText !== undefined ? { editorText: record.editorText } : {}),
  ...(record.failure ? { failure: record.failure } : {}),
  ...(record.navigationMarkerId ? { navigationMarkerId: record.navigationMarkerId } : {}),
  ...(record.plan.undoOf ? { undoOf: record.plan.undoOf } : {}),
});

const bindingFailure = (
  message: string,
  paths: string[] = [],
  options: BindingFailureOptions = {},
): WorkspaceRecoveryFailure => ({
  code: options.code ?? 'checkpoint-incomplete',
  message,
  origin: options.origin ?? 'coverage',
  retryable: options.retryable === true,
  ...((paths.length > 0 || options.reason) ? { details: {
    ...(paths.length > 0 ? { paths } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
  } } : {}),
});

const providerBindingFailure = (message: string, paths: string[] = []): WorkspaceRecoveryFailure => bindingFailure(message, paths, {
  code: 'checkpoint-unavailable',
  origin: 'provider',
  reason: 'provider-failure',
  retryable: true,
});

const runImmediateTransaction = <T>(database: SqliteDatabase, label: string, operation: () => T): T => {
  try {
    return database.transaction(operation).immediate();
  } catch (error) {
    const code = errorCode(error) ?? '';
    if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')
      || (code.startsWith('SQLITE_CONSTRAINT') && String(error instanceof Error ? error.message : '').includes('checkpoints.workspace_id'))) {
      throw new RecoveryPrimitiveError('recovery-in-progress', `${label} raced with another recovery process`, {
        cause: error,
        origin: 'concurrency',
        retryable: true,
      });
    }
    throw error;
  }
};

const conflictFingerprint = (value: unknown): string => operationRevision(value);

export const createWorkspaceRecoveryEngine = (
  options: CreateWorkspaceRecoveryEngineOptions,
): WorkspaceRecoveryEngine => {
  const {
    authorityId,
    dataDir,
    defaultRecoveryDir,
    documents,
    fsModule = fs,
    fsPromises = fs.promises,
    pathModule = path,
    sessionNavigation,
    storageOwnerId = 'piarium.builtin.recovery',
    fileStore: fileStoreOverride,
  } = options;
  const locations = createRecoveryLocationRegistry({
    authorityId,
    dataDir,
    defaultRecoveryDir,
    fsPromises,
    pathModule,
    storageOwnerId,
  });
  const fileStore = fileStoreOverride ?? createRecoveryFileStore({ fsModule, fsPromises, pathModule });
  const leases = createRecoveryWorkspaceLeaseManager({ fsModule, fsPromises, pathModule });
  const queues = new Map<string, Promise<unknown>>();
  const startupFailures = new Map<string, WorkspaceRecoveryFailure[]>();
  let disposed = false;

  const rememberFailure = (
    workspaceId: string,
    error: unknown,
    fallbackCode: WorkspaceRecoveryFailureCode = 'internal',
  ): void => {
    const failures = startupFailures.get(workspaceId) ?? [];
    failures.push(recoveryFailure(error, fallbackCode));
    startupFailures.set(workspaceId, failures);
  };
  const rememberLeaseReleaseFailure = (workspaceId: string, error: unknown): void => rememberFailure(
    workspaceId,
    new RecoveryPrimitiveError('lease-unavailable', 'Recovery workspace lease could not be released', {
      cause: error,
      origin: 'concurrency',
      retryable: true,
    }),
  );

  const runWorkspace = <T>(
    workspaceId: string,
    operation: () => Promise<T> | T,
    leaseOptions: WorkspaceLeaseOptions | null = null,
  ): Promise<T> => {
    const previous = queues.get(workspaceId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      if (disposed) {
        throw new RecoveryPrimitiveError('unavailable', 'Workspace recovery engine is disposed', {
          origin: 'internal',
          retryable: true,
        });
      }
      if (!leaseOptions) return operation();
      const { identity } = await inspectStorageIdentity(workspaceId);
      const storage = await storageFor(identity, true);
      const lease = await leases.acquire({
        root: storage.root,
        workspaceId,
        mode: leaseOptions.mode,
        purpose: leaseOptions.purpose,
      });
      try {
        return await operation();
      } finally {
        try {
          await lease.release();
        } catch (error) {
          // The logical operation has already committed or failed. A lease
          // metadata cleanup error must not turn a committed restore into a
          // false rollback result or hide the original operation failure.
          rememberLeaseReleaseFailure(workspaceId, error);
          // The retained durable owner continues fencing later operations;
          // status() exposes the failure and dispose() retries cleanup.
        }
      }
    });
    queues.set(workspaceId, current as Promise<unknown>);
    void current.finally(() => {
      if (queues.get(workspaceId) === current) queues.delete(workspaceId);
    }).catch(() => undefined);
    return current;
  };

  const inspectIdentity = async (workspaceId: string): Promise<RecoveryIdentity> => {
    const workspace = await documents.inspectWorkspace(workspaceId);
    return {
      authorityId,
      canonicalRoot: workspace.root,
      filesystemProfile: process.platform === 'win32' ? 'windows-local' : `${process.platform}-local`,
      workspaceId,
    };
  };

  const inspectStorageIdentity = async (workspaceId: string): Promise<{
    identity: RecoveryIdentity;
    workspaceAvailable: boolean;
  }> => {
    try {
      return { identity: await inspectIdentity(workspaceId), workspaceAvailable: true };
    } catch (error) {
      const registration = (await documents.listWorkspaceRegistrations())
        .find((entry) => entry.workspaceId === workspaceId);
      if (!registration) throw error;
      return {
        identity: {
          authorityId,
          canonicalRoot: registration.canonicalPath,
          filesystemProfile: process.platform === 'win32' ? 'windows-local' : `${process.platform}-local`,
          workspaceId,
        },
        workspaceAvailable: false,
      };
    }
  };

  const storageFor = async (identity: RecoveryIdentity, create = true): Promise<{
    root: string;
    selected: Awaited<ReturnType<RecoveryLocationRegistry['selection']>>;
  }> => {
    const selected = create
      ? await locations.materialize(identity.workspaceId)
      : await locations.selection(identity.workspaceId);
    return {
      root: await locations.resolve(identity, selected.location),
      selected,
    };
  };

  const nextSequence = (database: SqliteDatabase, workspaceId: string): number => {
    const row = database.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM checkpoints WHERE workspace_id = ?')
      .get(workspaceId) as { value: number };
    return row.value + 1;
  };

  const checkpointFor = (database: SqliteDatabase, checkpointId: string): WorkspaceRecoveryCheckpointSummary | null => {
    const row = database.prepare('SELECT * FROM checkpoints WHERE id = ?').get(checkpointId) as CheckpointRow | undefined;
    return row ? parseCheckpointRow(row) : null;
  };

  const bindingFor = (database: SqliteDatabase, executionId: string): WorkspaceRecoveryTurnBinding | null => {
    const row = database.prepare('SELECT * FROM turn_bindings WHERE execution_id = ?').get(executionId) as BindingRow | undefined;
    return row ? parseBindingRow(row) : null;
  };

  const addJournaledPath = (database: SqliteDatabase, executionId: string, relativePath: string): void => {
    const row = database.prepare(`
      SELECT journaled_resource_ids_json FROM turn_bindings WHERE execution_id = ?
    `).get(executionId) as { journaled_resource_ids_json: string } | undefined;
    if (!row) return;
    const parsed = JSON.parse(row.journaled_resource_ids_json) as unknown;
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
      throw new RecoveryPrimitiveError('storage-malformed', 'Recovery journaled paths are malformed', { origin: 'storage' });
    }
    const paths = new Set<string>(parsed);
    paths.add(relativePath);
    database.prepare(`
      UPDATE turn_bindings SET journaled_resource_ids_json = ? WHERE execution_id = ?
    `).run(JSON.stringify([...paths].sort()), executionId);
  };

  const updateCheckpointStats = (database: SqliteDatabase, checkpointId: string): void => {
    const rows = database.prepare(`
      SELECT before_json, after_json FROM checkpoint_changes
      WHERE checkpoint_id = ? AND after_json IS NOT NULL
    `).all(checkpointId) as { after_json: string; before_json: string }[];
    let byteLength = 0;
    let changedPathCount = 0;
    for (const row of rows) {
      const before = parseRecoveryState(JSON.parse(row.before_json) as unknown);
      const after = parseRecoveryState(JSON.parse(row.after_json) as unknown);
      if (sameState(before, after)) continue;
      changedPathCount += 1;
      byteLength += Math.max(stateByteLength(before), stateByteLength(after));
    }
    database.prepare(`
      UPDATE checkpoints SET changed_path_count = ?, byte_length = ? WHERE id = ?
    `).run(changedPathCount, byteLength, checkpointId);
  };

  const setBindingIncomplete = (
    database: SqliteDatabase,
    binding: WorkspaceRecoveryTurnBinding,
    failure: WorkspaceRecoveryFailure,
    paths: string[] = binding.unrecordedResourceIds,
  ): void => {
    runImmediateTransaction(database, 'Recovery binding update', () => {
      database.prepare(`
        UPDATE turn_bindings
        SET status = 'incomplete', failure_json = ?, unrecorded_resource_ids_json = ?
        WHERE execution_id = ?
      `).run(JSON.stringify(failure), JSON.stringify(paths), binding.executionId);
      database.prepare("UPDATE checkpoints SET state = 'incomplete' WHERE id = ?")
        .run(binding.checkpointId);
    });
  };

  const openWritableCatalog = async (root: string): Promise<SqliteDatabase> => {
    const database = await openRecoveryJournalCatalog(root, { create: true, fsPromises });
    if (!database) {
      throw new RecoveryPrimitiveError('checkpoint-unavailable', 'Recovery catalog could not be created', {
        origin: 'storage',
        retryable: true,
      });
    }
    return database;
  };

  const openExistingCatalog = async (root: string, operationId?: string): Promise<SqliteDatabase> => {
    const database = await openRecoveryJournalCatalog(root, { create: false, fsPromises });
    if (!database) {
      throw new RecoveryPrimitiveError(
        operationId ? 'operation-not-found' : 'checkpoint-missing',
        operationId ? `Unknown recovery operation: ${operationId}` : 'Recovery catalog is missing',
        { origin: 'storage' },
      );
    }
    return database;
  };

  const recordTurnStartInternal = async (
    input: WorkspaceRecoveryTurnStartInput,
  ): Promise<WorkspaceRecoveryTurnBinding> => {
    const identity = await inspectIdentity(input.workspaceId);
    const storage = await storageFor(identity);
    const database = await openWritableCatalog(storage.root);
    try {
      const checkpointId = randomUUID();
      const createdAt = new Date().toISOString();
      let result: WorkspaceRecoveryTurnBinding | null = null;
      runImmediateTransaction(database, 'Turn checkpoint creation', () => {
        const existing = bindingFor(database, input.executionId);
        if (existing) {
          result = existing;
          return;
        }
        database.prepare(`
          INSERT INTO checkpoints(
            id, workspace_id, sequence, source, state, created_at, session_id, entry_id, execution_id
          ) VALUES (?, ?, ?, 'turn', ?, ?, ?, ?, ?)
        `).run(
          checkpointId,
          input.workspaceId,
          nextSequence(database, input.workspaceId),
          input.failure ? 'incomplete' : 'pending',
          createdAt,
          input.sessionId,
          input.userEntryId,
          input.executionId,
        );
        database.prepare(`
          INSERT INTO turn_bindings(
            execution_id, runtime_key, runtime_generation, worker_id, session_id, workspace_id,
            user_entry_id, checkpoint_id, active_writer_scopes_json, provenance, status,
            journaled_resource_ids_json, unrecorded_resource_ids_json, failure_json, started_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?)
        `).run(
          input.executionId,
          `${input.workerId}@${input.runtimeGeneration}`,
          input.runtimeGeneration,
          input.workerId,
          input.sessionId,
          input.workspaceId,
          input.userEntryId,
          checkpointId,
          JSON.stringify(input.activeWriterScopes),
          input.provenance,
          input.failure ? 'incomplete' : 'pending',
          input.failure ? JSON.stringify(input.failure) : null,
          createdAt,
        );
        result = bindingFor(database, input.executionId);
      });
      if (!result) {
        throw new RecoveryPrimitiveError('checkpoint-unavailable', 'Turn checkpoint could not be created', {
          origin: 'storage',
          retryable: true,
        });
      }
      return result;
    } finally {
      database.close();
    }
  };

  const recordMutationBeforeInternal = async (
    input: WorkspaceRecoveryMutationBeforeInput,
  ): Promise<boolean> => {
    const identity = await inspectIdentity(input.workspaceId);
    const storage = await storageFor(identity);
    const database = await openWritableCatalog(storage.root);
    try {
      const binding = bindingFor(database, input.executionId);
      if (!binding || binding.workspaceId !== input.workspaceId || binding.status === 'incomplete') return false;
      const captured = await fileStore.captureState(identity, storage.root, input.path, { store: true });
      const existing = database.prepare(`
        SELECT 1 FROM checkpoint_changes WHERE checkpoint_id = ? AND path = ?
      `).get(binding.checkpointId, captured.path) as { 1: number } | undefined;
      runImmediateTransaction(database, 'Recovery before-image record', () => {
        if (!existing) {
          const now = new Date().toISOString();
          database.prepare(`
            INSERT INTO checkpoint_changes(
              checkpoint_id, path, tool_name, mutation_id, before_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            binding.checkpointId,
            captured.path,
            input.toolName,
            input.mutationId,
            JSON.stringify(captured.state),
            now,
            now,
          );
          replaceObjectReferences(
            database,
            input.workspaceId,
            'checkpoint-change',
            JSON.stringify([binding.checkpointId, captured.path]),
            stateObjectHash(captured.state)
              ? [{ objectHash: stateObjectHash(captured.state)!, slot: 'before' }]
              : [],
          );
        }
        addJournaledPath(database, input.executionId, captured.path);
      });
      return true;
    } catch (error) {
      const binding = bindingFor(database, input.executionId);
      if (binding) setBindingIncomplete(database, binding, providerBindingFailure(
        error instanceof Error ? error.message : 'Unable to record the file before mutation',
      ));
      throw error;
    } finally {
      database.close();
    }
  };

  const recordMutationAfterInternal = async (
    input: WorkspaceRecoveryMutationAfterInput,
  ): Promise<boolean> => {
    const identity = await inspectIdentity(input.workspaceId);
    const storage = await storageFor(identity);
    const database = await openWritableCatalog(storage.root);
    try {
      const binding = bindingFor(database, input.executionId);
      if (!binding || binding.workspaceId !== input.workspaceId || binding.status === 'incomplete') return false;
      const captured = await fileStore.captureState(identity, storage.root, input.path, { store: true });
      const row = database.prepare(`
        SELECT * FROM checkpoint_changes WHERE checkpoint_id = ? AND path = ?
      `).get(binding.checkpointId, captured.path) as ChangeRow | undefined;
      if (!row) {
        setBindingIncomplete(database, binding, providerBindingFailure(
          `Mutation finished without a durable before-image: ${captured.path}`,
          [captured.path],
        ), [captured.path]);
        return false;
      }
      const change = parseChangeRow(row);
      const changed = !sameState(change.before, captured.state);
      runImmediateTransaction(database, 'Recovery after-image record', () => {
        const ownerId = JSON.stringify([binding.checkpointId, captured.path]);
        if (changed) {
          database.prepare(`
            UPDATE checkpoint_changes
            SET after_json = ?, mutation_id = ?, tool_name = ?, updated_at = ?
            WHERE checkpoint_id = ? AND path = ?
          `).run(
            JSON.stringify(captured.state),
            input.mutationId,
            input.toolName,
            new Date().toISOString(),
            binding.checkpointId,
            captured.path,
          );
          replaceObjectReferences(database, input.workspaceId, 'checkpoint-change', ownerId, [
            ...(stateObjectHash(change.before) ? [{ objectHash: stateObjectHash(change.before)!, slot: 'before' }] : []),
            ...(stateObjectHash(captured.state) ? [{ objectHash: stateObjectHash(captured.state)!, slot: 'after' }] : []),
          ]);
        } else {
          database.prepare('DELETE FROM checkpoint_changes WHERE checkpoint_id = ? AND path = ?')
            .run(binding.checkpointId, captured.path);
          deleteObjectReferences(database, input.workspaceId, 'checkpoint-change', ownerId);
        }
        updateCheckpointStats(database, binding.checkpointId);
      });
      return changed;
    } finally {
      database.close();
    }
  };

  const recordTurnSettledInternal = async (
    input: WorkspaceRecoveryTurnSettledInput,
  ): Promise<WorkspaceRecoveryTurnBinding> => {
    const identity = await inspectIdentity(input.workspaceId);
    const storage = await storageFor(identity);
    const database = await openWritableCatalog(storage.root);
    try {
      const binding = bindingFor(database, input.executionId);
      if (!binding) throw new RecoveryPrimitiveError('checkpoint-missing', 'Turn checkpoint was not created');
      const coverageRow = database.prepare(`
        SELECT journaled_resource_ids_json FROM turn_bindings WHERE execution_id = ?
      `).get(input.executionId) as { journaled_resource_ids_json: string } | undefined;
      if (!coverageRow) {
        throw new RecoveryPrimitiveError('checkpoint-missing', 'Turn checkpoint coverage is missing', { origin: 'storage' });
      }
      const rawRecorded = JSON.parse(coverageRow.journaled_resource_ids_json) as unknown;
      if (!Array.isArray(rawRecorded)) {
        throw new RecoveryPrimitiveError('storage-malformed', 'Turn checkpoint coverage is malformed', { origin: 'storage' });
      }
      const recorded = rawRecorded.map(normalizeResourceId);
      const comparison = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
      const recordedKeys = new Set(recorded.map(comparison));
      const observed = [...new Set(input.observedResourceIds
        .map(normalizeResourceId)
        .filter((value): value is string => Boolean(value) && !IGNORED_WATCH_PATH.test(value)))].sort();
      const unrecorded = observed.filter((value) => !recordedKeys.has(comparison(value)));
      const retainedFailure = binding.status === 'incomplete' && binding.failure?.origin === 'provider'
        ? binding.failure
        : undefined;
      const exact = !input.failure
        && !retainedFailure
        && (!input.mutationObserved || input.observationComplete)
        && unrecorded.length === 0
        && !(input.mutationObserved && recorded.length === 0 && observed.length === 0);
      const failure = input.failure ?? retainedFailure ?? (exact ? undefined : bindingFailure(
        unrecorded.length > 0
          ? `Some changed paths were not captured before mutation: ${unrecorded.join(', ')}`
          : 'Workspace activity was observed outside the exact write/edit journal',
        unrecorded,
      ));
      const settledAt = new Date().toISOString();
      runImmediateTransaction(database, 'Turn checkpoint settlement', () => {
        database.prepare(`
          UPDATE turn_bindings SET assistant_entry_id = ?, active_writer_scopes_json = ?,
            provenance = ?, status = ?, unrecorded_resource_ids_json = ?, failure_json = ?, settled_at = ?
          WHERE execution_id = ?
        `).run(
          input.assistantEntryId ?? null,
          JSON.stringify(input.activeWriterScopes),
          input.provenance,
          exact ? 'ready' : 'incomplete',
          JSON.stringify(unrecorded),
          failure ? JSON.stringify(failure) : null,
          settledAt,
          input.executionId,
        );
        database.prepare('UPDATE checkpoints SET state = ? WHERE id = ?')
          .run(exact ? 'ready' : 'incomplete', binding.checkpointId);
        updateCheckpointStats(database, binding.checkpointId);
      });
      const settled = bindingFor(database, input.executionId);
      if (!settled) throw new RecoveryPrimitiveError('checkpoint-missing', 'Settled turn checkpoint is missing', { origin: 'storage' });
      return settled;
    } finally {
      database.close();
    }
  };

  const resolveEntryInternal = async (
    input: WorkspaceRecoveryEntryTarget,
  ): Promise<Exclude<WorkspaceRecoveryEntryBindingResult, WorkspaceRecoveryFailedResult>> => {
    const identity = await inspectIdentity(input.workspaceId);
    const storage = await storageFor(identity, false);
    const database = await openRecoveryJournalCatalog(storage.root, { create: false, fsPromises });
    if (!database) return { reason: 'session-unbound', status: 'unbound' };
    try {
      const row = database.prepare(`
        SELECT * FROM turn_bindings
        WHERE session_id = ? AND workspace_id = ?
          AND (user_entry_id = ? OR assistant_entry_id = ?)
        LIMIT 1
      `).get(input.sessionId, input.workspaceId, input.entryId, input.entryId) as BindingRow | undefined;
      if (!row) return { reason: 'entry-unbound', status: 'unbound' };
      const binding = parseBindingRow(row);
      if (binding.status !== 'ready') return { binding, reason: 'checkpoint-incomplete', status: 'incomplete' };
      const checkpoint = checkpointFor(database, binding.checkpointId);
      if (!checkpoint || checkpoint.state !== 'ready') {
        return { binding, reason: 'checkpoint-incomplete', status: 'incomplete' };
      }
      return {
        binding,
        checkpoint,
        position: binding.userEntryId === input.entryId ? 'before' : 'after',
        status: 'ready',
      };
    } finally {
      database.close();
    }
  };

  const changesForEntries = (
    database: SqliteDatabase,
    sessionId: string,
    entryIds: string[],
  ): {
    changes: SequencedRecoveryChange[];
    hasIncompleteCheckpoint: boolean;
    uncoveredPaths: WorkspaceRecoveryUncoveredPath[];
    uncoveredReasons: string[];
  } => {
    if (entryIds.length === 0) return { changes: [], hasIncompleteCheckpoint: false, uncoveredPaths: [], uncoveredReasons: [] };
    const placeholders = entryIds.map(() => '?').join(', ');
    const checkpoints = database.prepare(`
      SELECT DISTINCT b.checkpoint_id, b.status, c.sequence
      FROM turn_bindings b
      JOIN checkpoints c ON c.id = b.checkpoint_id
      WHERE b.session_id = ?
        AND (b.user_entry_id IN (${placeholders}) OR b.assistant_entry_id IN (${placeholders}))
      ORDER BY c.sequence ASC
    `).all(sessionId, ...entryIds, ...entryIds) as {
      checkpoint_id: string;
      sequence: number;
      status: string;
    }[];
    const changes: SequencedRecoveryChange[] = [];
    // Collect journaled changes from ALL checkpoints (both ready and incomplete).
    // An incomplete checkpoint still has valid before-images for paths that were
    // journaled via write/edit tools; only the unjournaled (shell/external) paths
    // are uncovered. Skipping all changes from an incomplete checkpoint would
    // incorrectly treat journaled paths as unrestorable.
    for (const checkpoint of checkpoints) {
      for (const row of database.prepare(`
        SELECT * FROM checkpoint_changes WHERE checkpoint_id = ? AND after_json IS NOT NULL
        ORDER BY path
      `).all(checkpoint.checkpoint_id) as ChangeRow[]) {
        const change = parseChangeRow(row);
        const after = change.after;
        if (after && !sameState(change.before, after)) {
          changes.push({ ...change, after, sequence: checkpoint.sequence });
        }
      }
    }
    // Expand incomplete checkpoints to per-path uncovered entries and reasons.
    // For each incomplete checkpoint, read its binding's unrecorded_resource_ids
    // (paths observed by the watcher but not journaled), active_writer_scopes
    // (to attribute the source via the writerScope prefix), and failure_json
    // (the human-readable reason the checkpoint is incomplete).
    const uncoveredMap = new Map<string, WorkspaceRecoveryUncoveredPath>();
    const reasonsSet = new Set<string>();
    const hasIncomplete = checkpoints.some((row) => row.status !== 'ready');
    for (const checkpoint of checkpoints.filter((row) => row.status !== 'ready')) {
      const bindingRow = database.prepare(`
        SELECT unrecorded_resource_ids_json, active_writer_scopes_json, failure_json
        FROM turn_bindings WHERE checkpoint_id = ?
      `).get(checkpoint.checkpoint_id) as {
        unrecorded_resource_ids_json: string;
        active_writer_scopes_json: string;
        failure_json: string | null;
      } | undefined;
      if (!bindingRow) continue;
      let unrecorded: string[] = [];
      try {
        const parsed = JSON.parse(bindingRow.unrecorded_resource_ids_json);
        if (Array.isArray(parsed)) unrecorded = parsed.filter((v): v is string => typeof v === 'string');
      } catch { /* malformed JSON → treat as no unrecorded paths */ }
      let scopes: string[] = [];
      try {
        const parsed = JSON.parse(bindingRow.active_writer_scopes_json);
        if (Array.isArray(parsed)) scopes = parsed.filter((v): v is string => typeof v === 'string');
      } catch { /* malformed → treat as no scopes */ }
      // Source attribution via writerScope prefix: `${mode}/${kind}:${id}@gen`.
      // process/ → shell, external/ → external, other or legacy → unknown.
      const hasProcessWriter = scopes.some((scope) => scope.startsWith('process/'));
      const hasExternalWriter = scopes.some((scope) => scope.startsWith('external/'));
      const source: WorkspaceRecoveryUncoveredPath['source'] = hasProcessWriter
        ? 'shell'
        : hasExternalWriter
          ? 'external'
          : 'unknown';
      for (const path of unrecorded) {
        if (!uncoveredMap.has(path)) {
          uncoveredMap.set(path, { path, source });
        }
      }
      // Collect the failure message as an uncovered reason.
      if (bindingRow.failure_json) {
        try {
          const failure = JSON.parse(bindingRow.failure_json) as { message?: unknown };
          if (typeof failure.message === 'string' && failure.message) {
            reasonsSet.add(failure.message);
          }
        } catch { /* malformed failure JSON → skip reason */ }
      }
    }
    return {
      changes,
      hasIncompleteCheckpoint: hasIncomplete,
      uncoveredPaths: [...uncoveredMap.values()].sort((a, b) => a.path.localeCompare(b.path)),
      uncoveredReasons: [...reasonsSet].sort(),
    };
  };

  const mergeInverseTargets = (changes: SequencedRecoveryChange[]): {
    byPath: Map<string, RecoveryTargetStates>;
    chainConflicts: string[];
  } => {
    const byPath = new Map<string, RecoveryTargetStates>();
    const chainConflicts = new Set<string>();
    for (const change of changes.sort((left, right) => left.sequence - right.sequence)) {
      const current = byPath.get(change.path);
      if (!current) byPath.set(change.path, { expected: change.after, target: change.before });
      else {
        if (!sameState(current.expected, change.before)) chainConflicts.add(change.path);
        current.expected = change.after;
      }
    }
    return { byPath, chainConflicts: [...chainConflicts] };
  };

  const inspectTargetConflicts = async (
    identity: RecoveryIdentity,
    root: string,
    targets: RecoveryTargets,
    options: { store?: boolean | undefined } = {},
  ): Promise<{ conflicts: WorkspaceRecoveryConflict[]; currentStates: Record<string, RecoveryState> }> => {
    let dirtyOwners: DirtyBufferPublication[];
    try {
      dirtyOwners = await documents.inspectDirtyBuffers(identity.workspaceId);
    } catch (error) {
      throw new RecoveryPrimitiveError('dirty-state-unavailable', 'Unsaved editor state could not be verified', {
        cause: error,
        origin: 'conflict',
        retryable: true,
      });
    }
    const comparison = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
    const dirtyByPath = new Map<string, {
      baseRevision: string | null;
      generation: number;
      localEditRevision: number;
      ownerId: string;
    }[]>();
    for (const owner of dirtyOwners) {
      for (const entry of owner.resources) {
        const key = comparison(normalizeResourceId(entry.resource.resourceId));
        const records = dirtyByPath.get(key) ?? [];
        records.push({
          baseRevision: entry.baseRevision ?? null,
          generation: owner.generation,
          localEditRevision: entry.localEditRevision,
          ownerId: owner.ownerId,
        });
        dirtyByPath.set(key, records);
      }
    }
    for (const records of dirtyByPath.values()) {
      records.sort((left, right) => left.ownerId.localeCompare(right.ownerId)
        || left.generation - right.generation
        || left.localEditRevision - right.localEditRevision);
    }
    const conflicts: WorkspaceRecoveryConflict[] = [];
    const currentStates: Record<string, RecoveryState> = {};
    for (const [relativePath, states] of Object.entries(targets)) {
      try {
        const current = (await fileStore.captureState(identity, root, relativePath, {
          store: options.store === true,
        })).state;
        currentStates[relativePath] = current;
        const dirty = dirtyByPath.get(comparison(relativePath)) ?? [];
        if (dirty.length > 0) {
          conflicts.push({
            fingerprint: conflictFingerprint({
              current: stateIdentity(current),
              dirty,
              kind: 'dirty-buffer',
              path: comparison(relativePath),
            }),
            kind: 'dirty-buffer',
            message: 'This file has unsaved editor changes',
            path: relativePath,
          });
          continue;
        }
        if (!sameState(current, states.expected)) {
          conflicts.push({
            fingerprint: conflictFingerprint({
              current: stateIdentity(current),
              expected: stateIdentity(states.expected),
              kind: 'content-changed',
              path: comparison(relativePath),
            }),
            kind: 'content-changed',
            message: 'The file changed after this checkpoint',
            path: relativePath,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        conflicts.push({
          fingerprint: conflictFingerprint({ kind: 'unsupported', message, path: comparison(relativePath) }),
          kind: 'unsupported',
          message,
          path: relativePath,
        });
      }
    }
    return { conflicts, currentStates };
  };

  const beginDirtyBarrier = async (
    identity: RecoveryIdentity,
    paths: string[],
  ): Promise<DirtyBarrierHandle> => {
    if (paths.length === 0) return { release: async () => undefined, settle: async () => undefined };
    if (typeof documents.beginDirtyStateBarrier !== 'function') {
      throw new RecoveryPrimitiveError('dirty-state-unavailable', 'Document surfaces do not support a dirty-state barrier', {
        origin: 'conflict',
        retryable: true,
      });
    }
    try {
      return await documents.beginDirtyStateBarrier(identity.workspaceId, paths, {
        caseSensitive: !identity.filesystemProfile.startsWith('windows'),
      });
    } catch (error) {
      throw new RecoveryPrimitiveError('dirty-state-unavailable', 'Unsaved editor state could not be synchronized', {
        cause: error,
        origin: 'conflict',
        retryable: true,
      });
    }
  };

  const buildConflicts = async (
    identity: RecoveryIdentity,
    root: string,
    targets: RecoveryTargets,
  ): Promise<WorkspaceRecoveryConflict[]> => (
    await inspectTargetConflicts(identity, root, targets)
  ).conflicts;

  const validateConflictConfirmation = (
    planned: WorkspaceRecoveryConflict[],
    current: WorkspaceRecoveryConflict[],
    input: WorkspaceCombinedRecoveryApplyInput,
  ): void => {
    const plannedByPath = new Map(planned.map((conflict) => [conflict.path, conflict]));
    const currentByPath = new Map(current.map((conflict) => [conflict.path, conflict]));
    // unsupported conflicts can never be overwritten by any policy.
    if (planned.some((conflict) => conflict.kind === 'unsupported')
      || current.some((conflict) => conflict.kind === 'unsupported')) {
      throw new RecoveryPrimitiveError('unsupported-metadata', 'An affected path cannot be safely inspected', {
        details: { paths: [...new Set([...planned, ...current]
          .filter((conflict) => conflict.kind === 'unsupported')
          .map((conflict) => conflict.path))] },
        origin: 'conflict',
      });
    }
    if (input.conflictPolicy === 'abort') {
      if (planned.length > 0 || current.length > 0) {
        throw new RecoveryPrimitiveError('path-conflict', 'Some affected files changed after the checkpoint', {
          details: { paths: [...new Set([...plannedByPath.keys(), ...currentByPath.keys()])] },
          origin: 'conflict',
        });
      }
      return;
    }
    // overwrite-confirmed: dirty-buffer conflicts cannot be authorized by a
    // generic overwrite confirmation. They require a completed dirty barrier
    // flow (not yet implemented). Until that exists, reject them explicitly.
    const dirtyBufferPaths = [...new Set([...planned, ...current]
      .filter((conflict) => conflict.kind === 'dirty-buffer')
      .map((conflict) => conflict.path))];
    if (dirtyBufferPaths.length > 0) {
      throw new RecoveryPrimitiveError('dirty-buffers', 'Unsaved editor changes must be saved or discarded before recovery', {
        details: { paths: dirtyBufferPaths },
        origin: 'conflict',
      });
    }
    const confirmedByPath = new Map(input.confirmedConflicts.map((conflict) => [conflict.path, conflict]));
    // No duplicate paths in confirmed conflicts.
    if (input.confirmedConflicts.length !== confirmedByPath.size) {
      throw new RecoveryPrimitiveError('invalid-request', 'Confirmed conflicts contain duplicate paths', {
        origin: 'conflict',
      });
    }
    const paths = new Set([...plannedByPath.keys(), ...currentByPath.keys(), ...confirmedByPath.keys()]);
    const changed = [...paths].filter((relativePath) => {
      const plannedConflict = plannedByPath.get(relativePath);
      const currentConflict = currentByPath.get(relativePath);
      const confirmed = confirmedByPath.get(relativePath);
      // A conflict must exist in both plan and current, and the confirmed
      // fingerprint must match both. New, disappeared, or changed fingerprints
      // all produce a retryable stale-plan.
      return !plannedConflict || !currentConflict || !confirmed
        || plannedConflict.fingerprint !== confirmed.fingerprint
        || currentConflict.fingerprint !== confirmed.fingerprint;
    });
    if (changed.length > 0) {
      throw new RecoveryPrimitiveError('stale-plan', 'Affected files changed after conflict review', {
        details: { paths: changed },
        origin: 'conflict',
        retryable: true,
      });
    }
  };

  const persistOperation = (database: SqliteDatabase, record: CombinedOperationRecord): void => {
    record.updatedAt = new Date().toISOString();
    writeOperationRow(database, {
      createdAt: record.createdAt,
      data: record,
      id: record.id,
      kind: 'combined',
      state: record.state,
      updatedAt: record.updatedAt,
      workspaceId: record.plan.workspaceId,
    });
  };

  const locateOperation = async (operationId: string): Promise<LocatedOperation> => {
    const registrations = await documents.listWorkspaceRegistrations();
    let inspectionFailure: unknown;
    for (const registration of registrations) {
      let identity: RecoveryIdentity;
      try {
        identity = await inspectIdentity(registration.workspaceId);
      } catch (error) {
        inspectionFailure ??= error;
        continue;
      }
      let storage: Awaited<ReturnType<typeof storageFor>>;
      let database: SqliteDatabase | null;
      try {
        storage = await storageFor(identity, false);
        database = await openRecoveryJournalCatalog(storage.root, { create: false, fsPromises });
      } catch (error) {
        inspectionFailure ??= error;
        continue;
      }
      if (!database) continue;
      try {
        const row = database.prepare("SELECT * FROM operations WHERE id = ? AND kind = 'combined'")
          .get(operationId) as OperationRow | undefined;
        if (row) return { identity, record: parseCombinedOperationRecord(row), root: storage.root };
      } finally {
        database.close();
      }
    }
    if (inspectionFailure) {
      throw new RecoveryPrimitiveError('storage-malformed', 'Recovery operation lookup could not inspect every workspace catalog', {
        cause: inspectionFailure,
        origin: 'storage',
      });
    }
    throw new RecoveryPrimitiveError('operation-not-found', `Unknown recovery operation: ${operationId}`);
  };

  const prepareCombinedInternal = async (
    input: WorkspaceCombinedRecoveryPrepareInput,
  ): Promise<WorkspaceCombinedRecoveryPlan> => {
    const identity = await inspectIdentity(input.workspaceId);
    const storage = await storageFor(identity);
    const navigation = await sessionNavigation.prepare(input);
    const removedEntryIds = [...new Set(navigation.removedEntryIds ?? [])];
    const database = await openWritableCatalog(storage.root);
    try {
      const _targetBinding = await resolveEntryInternal(input);
      const loaded = changesForEntries(database, input.sessionId, removedEntryIds);
      const merged = mergeInverseTargets(loaded.changes);
      const targets = Object.fromEntries(merged.byPath);
      const dirtyBarrier = await beginDirtyBarrier(identity, Object.keys(targets));
      let conflicts: WorkspaceRecoveryConflict[];
      try {
        conflicts = await buildConflicts(identity, storage.root, targets);
      } finally {
        await dirtyBarrier.release();
      }
      for (const relativePath of merged.chainConflicts) {
        conflicts.push({
          fingerprint: conflictFingerprint({ kind: 'chain-conflict', path: relativePath }),
          kind: 'unsupported',
          message: 'Recorded file history is not contiguous',
          path: relativePath,
        });
      }
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const affectedPaths = Object.keys(targets).sort();
      const changedBytes = Object.values(targets).reduce((total, states) => (
        total + Math.max(stateByteLength(states.target), stateByteLength(states.expected))
      ), 0);
      const uncoveredPaths = loaded.uncoveredPaths;
      const uncoveredReasons = loaded.uncoveredReasons;
      const hasRestorablePaths = affectedPaths.length > 0;
      // Coverage cannot be 'ready' if any checkpoint in range is incomplete
      // (worker exit, host stop, observationComplete=false, or observed
      // out-of-journal activity with no specific paths). An incomplete
      // checkpoint with empty unrecorded_resource_ids still disqualifies
      // 'ready' because the journal cannot prove it captured everything.
      const hasCoverageGap = uncoveredPaths.length > 0 || loaded.hasIncompleteCheckpoint;
      const coverage: WorkspaceCombinedRecoveryCoverage = !hasCoverageGap
        ? 'ready'
        : hasRestorablePaths
          ? 'partial'
          : 'none';
      const draft: Omit<WorkspaceCombinedRecoveryPlan, 'revision'> = {
        affectedPaths,
        changedBytes,
        conflicts,
        coverage,
        createdAt,
        entryId: input.entryId,
        expectedLeafId: navigation.expectedLeafId,
        id,
        removedEntryIds,
        sessionId: input.sessionId,
        targetLeafId: navigation.targetLeafId,
        uncoveredPaths,
        uncoveredReasons,
        workspaceId: input.workspaceId,
      };
      const plan: WorkspaceCombinedRecoveryPlan = { ...draft, revision: operationRevision(draft) };
      const record: CombinedOperationRecord = {
        appliedPaths: [],
        conversationState: 'unchanged',
        createdAt,
        editorImages: navigation.editorImages,
        editorText: navigation.editorText,
        failure: null,
        fileState: 'unchanged',
        id,
        navigationMarkerId: null,
        plan,
        safety: {},
        state: 'planned',
        targets,
        updatedAt: createdAt,
        workspaceId: input.workspaceId,
      };
      // Persist the operation row and initialize operation_files in the
      // same transaction so a crash cannot leave one without the other.
      database.transaction(() => {
        persistOperation(database, record);
        initOperationFiles(database, id, targets);
      })();
      return plan;
    } finally {
      database.close();
    }
  };

  const compensate = async (
    record: CombinedOperationRecord,
    identity: RecoveryIdentity,
    root: string,
    database: SqliteDatabase,
  ): Promise<void> => {
    record.state = 'compensating-files';
    persistOperation(database, record);
    // Compensate in reverse order, using operation_files phases to track
    // exactly which files were applied and need rollback.
    // Handle files in any of these phases:
    //   target-observed   → write phase=compensate-intent, then write safety
    //   compensate-intent → safety write was interrupted; continue writing safety
    //   safety-observed   → already compensated, skip
    //   needs-attention   → blocking terminal, must not be skipped
    //   pending/apply-intent → never applied, skip (no compensation needed)
    const fileRows = operationFileRows(database, record.id).reverse();
    for (const row of fileRows) {
      const relativePath = row.path;
      if (row.phase === 'safety-observed') continue;
      if (row.phase === 'pending' || row.phase === 'apply-intent') continue;
      if (row.phase === 'needs-attention') {
        throw new RecoveryPrimitiveError('needs-attention', `File ${relativePath} is in needs-attention state and blocks compensation`, {
          origin: 'storage',
        });
      }
      // target-observed or compensate-intent: verify disk is at target, then write safety
      if (row.phase === 'target-observed' || row.phase === 'compensate-intent') {
        const current = (await fileStore.captureState(identity, root, relativePath, { store: false })).state;
        if (!sameState(current, targetStatesFor(record, relativePath).target)) {
          updateOperationFilePhase(database, record.id, relativePath, 'needs-attention');
          throw new RecoveryPrimitiveError('needs-attention', `Cannot compensate a file changed after recovery: ${relativePath}`, {
            origin: 'storage',
          });
        }
        updateOperationFilePhase(database, record.id, relativePath, 'compensate-intent');
        await fileStore.applyState(identity, root, relativePath, safetyStateFor(record, relativePath));
        const safetyState = (await fileStore.captureState(identity, root, relativePath, { store: false })).state;
        if (!sameState(safetyState, safetyStateFor(record, relativePath))) {
          updateOperationFilePhase(database, record.id, relativePath, 'needs-attention');
          throw new RecoveryPrimitiveError('needs-attention', `Compensated file did not match safety state: ${relativePath}`, {
            origin: 'storage',
          });
        }
        updateOperationFilePhase(database, record.id, relativePath, 'safety-observed');
      }
    }
    record.fileState = 'compensated';
    record.state = 'compensated';
    persistOperation(database, record);
  };

  const applyLocatedOperation = async (
    located: LocatedOperation,
    input: WorkspaceCombinedRecoveryApplyInput,
  ): Promise<WorkspaceCombinedRecoveryOperation> => {
    const { identity, root } = located;
    const database = await openRecoveryJournalCatalog(root, { create: false, fsPromises });
    if (!database) throw new RecoveryPrimitiveError('operation-not-found', `Unknown recovery operation: ${input.operationId}`);
    let dirtyBarrier: DirtyBarrierHandle | undefined;
    try {
      const row = database.prepare("SELECT * FROM operations WHERE id = ? AND kind = 'combined'")
        .get(input.operationId) as OperationRow | undefined;
      if (!row) throw new RecoveryPrimitiveError('operation-not-found', `Unknown recovery operation: ${input.operationId}`);
      const record = parseCombinedOperationRecord(row);
      if (record.plan.revision !== input.expectedRevision) {
        throw new RecoveryPrimitiveError('stale-plan', 'Recovery plan changed before it was applied', {
          origin: 'conflict',
          retryable: true,
        });
      }
      if (TERMINAL_STATES.has(record.state)) return publicOperation(record);
      if (record.plan.coverage === 'none') {
        throw new RecoveryPrimitiveError('checkpoint-incomplete', 'This conversation range has no restorable file paths', {
          origin: 'coverage',
        });
      }
      dirtyBarrier = await beginDirtyBarrier(identity, record.plan.affectedPaths);
      // Re-check conflicts with fingerprints (TOCTOU protection).
      // The plan's conflicts were captured at prepare time; apply must verify
      // they haven't appeared, disappeared, or changed fingerprint since then.
      const currentConflicts = await buildConflicts(identity, root, record.targets);
      validateConflictConfirmation(record.plan.conflicts, currentConflicts, input);
      if (record.state === 'planned') {
        for (const relativePath of Object.keys(record.targets)) {
          const current = await fileStore.captureState(identity, root, relativePath, { store: true });
          record.safety[relativePath] = current.state;
          updateOperationFilePhase(database, record.id, relativePath, 'apply-intent', {
            safetyJson: JSON.stringify(current.state),
          });
        }
        record.state = 'applying-files';
        persistOperation(database, record);
      }
      await dirtyBarrier.settle();
      try {
        const fileRows = operationFileRows(database, record.id);
        for (const row of fileRows) {
          const relativePath = row.path;
          // needs-attention is a blocking terminal phase. It must never be
          // skipped by the apply loop — doing so would let the operation
          // proceed to files-restored and navigate the conversation despite
          // a file whose state could not be verified.
          if (row.phase === 'needs-attention') {
            throw new RecoveryPrimitiveError('needs-attention', `File ${relativePath} is in needs-attention state and blocks recovery`, {
              origin: 'storage',
            });
          }
          // Skip files that are already target-observed (resumed after crash).
          if (row.phase === 'target-observed') {
            if (!record.appliedPaths.includes(relativePath)) record.appliedPaths.push(relativePath);
            continue;
          }
          if (row.phase === 'safety-observed') continue;
          // Only apply-intent and pending files should be processed.
          if (row.phase !== 'apply-intent' && row.phase !== 'pending') continue;
          await dirtyBarrier.settle();
          // Always check current state equals safety, not just expected under abort.
          // This catches any change between safety capture and apply, regardless of
          // conflict policy. Under overwrite-confirmed the user authorized the
          // conflicts they saw; a *new* change after that is still a stale-plan.
          const current = (await fileStore.captureState(identity, root, relativePath, { store: false })).state;
          if (!sameState(current, safetyStateFor(record, relativePath))) {
            updateOperationFilePhase(database, record.id, relativePath, 'needs-attention');
            throw new RecoveryPrimitiveError('stale-plan', `File changed after safety capture: ${relativePath}`, {
              details: { paths: [relativePath] },
              origin: 'conflict',
              retryable: true,
            });
          }
          await fileStore.applyState(identity, root, relativePath, targetStatesFor(record, relativePath).target);
          const verified = (await fileStore.captureState(identity, root, relativePath, { store: false })).state;
          if (!sameState(verified, targetStatesFor(record, relativePath).target)) {
            updateOperationFilePhase(database, record.id, relativePath, 'needs-attention');
            throw new RecoveryPrimitiveError('needs-attention', `Restored file did not match its checkpoint: ${relativePath}`, {
              origin: 'storage',
            });
          }
          updateOperationFilePhase(database, record.id, relativePath, 'target-observed');
          if (!record.appliedPaths.includes(relativePath)) record.appliedPaths.push(relativePath);
          persistOperation(database, record);
        }
        record.fileState = record.plan.affectedPaths.length > 0 ? 'restored' : 'unchanged';
        record.state = 'files-restored';
        persistOperation(database, record);
      } catch (error) {
        if (record.appliedPaths.length > 0) {
          try {
            await compensate(record, identity, root, database);
          } catch (compensationError) {
            record.failure = recoveryFailure(compensationError, 'needs-attention');
            record.fileState = 'needs-attention';
            record.state = 'needs-attention';
            persistOperation(database, record);
            throw compensationError;
          }
        }
        if (operationFileRows(database, record.id).some((fileRow) => fileRow.phase === 'needs-attention')) {
          record.failure = recoveryFailure(error, 'needs-attention');
          record.fileState = 'needs-attention';
          record.state = 'needs-attention';
          persistOperation(database, record);
        }
        throw error;
      }
      record.state = 'navigating-conversation';
      persistOperation(database, record);
      try {
        const navigation = record.plan.undoOf
          ? await sessionNavigation.commitLeaf({
              expectedLeafId: record.plan.expectedLeafId,
              operationId: record.id,
              preparedTargetLeafId: record.plan.targetLeafId,
              sessionId: record.plan.sessionId,
              workspaceId: record.plan.workspaceId,
            })
          : await sessionNavigation.commit({
              entryId: record.plan.entryId,
              expectedLeafId: record.plan.expectedLeafId,
              operationId: record.id,
              preparedTargetLeafId: record.plan.targetLeafId,
              sessionId: record.plan.sessionId,
              workspaceId: record.plan.workspaceId,
            });
        record.conversationState = 'navigated';
        record.editorImages = navigation.editorImages ?? record.editorImages;
        record.editorText = navigation.editorText ?? record.editorText;
        record.navigationMarkerId = navigation.markerId ?? navigation.navigationMarkerId ?? null;
      } catch (error) {
        record.conversationState = 'diverged';
        if (record.appliedPaths.length > 0) await compensate(record, identity, root, database);
        record.failure = recoveryFailure(error, 'navigation-conflict');
        persistOperation(database, record);
        throw new RecoveryPrimitiveError('navigation-conflict', error instanceof Error ? error.message : 'Conversation navigation failed', {
          cause: error,
          operationId: record.id,
          origin: 'navigation',
        });
      }
      record.failure = null;
      record.state = 'complete';
      persistOperation(database, record);
      return publicOperation(record);
    } finally {
      await dirtyBarrier?.release();
      database.close();
    }
  };

  const getOperationInternal = async (operationId: string): Promise<WorkspaceCombinedRecoveryOperation> => {
    const located = await locateOperation(operationId);
    return publicOperation(located.record);
  };

  const cancelOperationInternal = async (operationId: string): Promise<WorkspaceCombinedRecoveryOperation> => {
    const located = await locateOperation(operationId);
    const database = await openExistingCatalog(located.root, operationId);
    try {
      const row = database.prepare('SELECT * FROM operations WHERE id = ?').get(operationId) as OperationRow | undefined;
      if (!row) throw new RecoveryPrimitiveError('operation-not-found', `Unknown recovery operation: ${operationId}`);
      const record = parseCombinedOperationRecord(row);
      if (record.state === 'planned') {
        record.state = 'aborted';
        persistOperation(database, record);
      }
      return publicOperation(record);
    } finally {
      database.close();
    }
  };

  const prepareUndoInternal = async (operationId: string): Promise<WorkspaceCombinedRecoveryPlan> => {
    const located = await locateOperation(operationId);
    const database = await openExistingCatalog(located.root, operationId);
    try {
      const row = database.prepare('SELECT * FROM operations WHERE id = ?').get(operationId) as OperationRow | undefined;
      if (!row) throw new RecoveryPrimitiveError('operation-not-found', `Unknown recovery operation: ${operationId}`);
      const original = parseCombinedOperationRecord(row);
      if (original.state !== 'complete') {
        throw new RecoveryPrimitiveError('recovery-in-progress', 'Only a completed recovery can be undone');
      }
      const navigation = await sessionNavigation.prepareLeaf({
        sessionId: original.plan.sessionId,
        targetLeafId: original.plan.expectedLeafId,
        workspaceId: original.plan.workspaceId,
      });
      const targets: RecoveryTargets = {};
      for (const relativePath of original.plan.affectedPaths) {
        const originalStates = targetStatesFor(original, relativePath);
        targets[relativePath] = {
          expected: originalStates.target,
          target: safetyStateFor(original, relativePath),
        };
      }
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const dirtyBarrier = await beginDirtyBarrier(located.identity, Object.keys(targets));
      let conflicts: WorkspaceRecoveryConflict[];
      try {
        conflicts = await buildConflicts(located.identity, located.root, targets);
      } finally {
        await dirtyBarrier.release();
      }
      const draft: Omit<WorkspaceCombinedRecoveryPlan, 'revision'> = {
        affectedPaths: Object.keys(targets).sort(),
        changedBytes: Object.values(targets).reduce((total, states) => (
          total + Math.max(stateByteLength(states.expected), stateByteLength(states.target))
        ), 0),
        conflicts,
        coverage: 'ready',
        createdAt,
        entryId: original.plan.entryId,
        expectedLeafId: navigation.expectedLeafId,
        id,
        removedEntryIds: [],
        sessionId: original.plan.sessionId,
        targetLeafId: navigation.targetLeafId,
        uncoveredPaths: [],
        uncoveredReasons: [],
        undoOf: original.id,
        workspaceId: original.plan.workspaceId,
      };
      const plan: WorkspaceCombinedRecoveryPlan = { ...draft, revision: operationRevision(draft) };
      database.transaction(() => {
        persistOperation(database, {
          appliedPaths: [],
          conversationState: 'unchanged',
          createdAt,
          failure: null,
          fileState: 'unchanged',
          id,
          navigationMarkerId: null,
          plan,
          safety: {},
          state: 'planned',
          targets,
          updatedAt: createdAt,
          workspaceId: original.plan.workspaceId,
        });
        initOperationFiles(database, id, targets);
      })();
      return plan;
    } finally {
      database.close();
    }
  };

  const createCheckpointInternal = async (
    input: WorkspaceRecoveryCheckpointInput,
  ): Promise<WorkspaceRecoveryCheckpointSummary> => {
    const identity = await inspectIdentity(input.workspaceId);
    const storage = await storageFor(identity);
    const database = await openWritableCatalog(storage.root);
    try {
      const id = randomUUID();
      runImmediateTransaction(database, 'Named checkpoint creation', () => {
        database.prepare(`
          INSERT INTO checkpoints(id, workspace_id, sequence, source, state, created_at, label)
          VALUES (?, ?, ?, 'named', 'ready', ?, ?)
        `).run(id, input.workspaceId, nextSequence(database, input.workspaceId), new Date().toISOString(), input.name);
      });
      const checkpoint = checkpointFor(database, id);
      if (!checkpoint) throw new RecoveryPrimitiveError('checkpoint-missing', 'Named checkpoint was not persisted', { origin: 'storage' });
      return checkpoint;
    } finally {
      database.close();
    }
  };

  const listCheckpointsInternal = async (input: WorkspaceRecoveryCheckpointQuery): Promise<{
    checkpoints: WorkspaceRecoveryCheckpointSummary[];
    nextCursor: number | null;
  }> => {
    const identity = await inspectIdentity(input.workspaceId);
    const storage = await storageFor(identity, false);
    const database = await openRecoveryJournalCatalog(storage.root, { create: false, fsPromises });
    if (!database) return { checkpoints: [], nextCursor: null };
    try {
      const limit = input.limit;
      const rows = database.prepare(`
        SELECT * FROM checkpoints
        WHERE workspace_id = ? AND (? IS NULL OR sequence < ?)
        ORDER BY sequence DESC LIMIT ?
      `).all(
        input.workspaceId,
        input.cursor ?? null,
        input.cursor ?? null,
        limit === undefined ? -1 : limit + 1,
      ) as CheckpointRow[];
      const hasMore = limit !== undefined && rows.length > limit;
      const checkpoints = (limit === undefined ? rows : rows.slice(0, limit)).map(parseCheckpointRow);
      return { checkpoints, nextCursor: hasMore ? checkpoints.at(-1)!.sequence : null };
    } finally {
      database.close();
    }
  };

  const listOperationsInternal = async (workspaceId: string): Promise<WorkspaceCombinedRecoveryOperation[]> => {
    const { identity } = await inspectStorageIdentity(workspaceId);
    const storage = await storageFor(identity, false);
    const database = await openRecoveryJournalCatalog(storage.root, { create: false, fsPromises });
    if (!database) return [];
    try {
      const rows = database.prepare(`
        SELECT * FROM operations WHERE workspace_id = ? AND kind = 'combined'
        ORDER BY created_at DESC
      `).all(workspaceId) as OperationRow[];
      return rows.map(parseCombinedOperationRecord).map(publicOperation);
    } finally {
      database.close();
    }
  };

  const storageStatusInternal = async (workspaceId?: string): Promise<RecoveryStorageStatus> => {
    const locationDocument = await locations.read();
    if (!workspaceId) {
      return {
        authorityId,
        byteLength: 0,
        catalog: { currentSchemaVersion: 0, retiredCatalogCount: 0, state: 'missing' },
        checkpointCount: 0,
        encryption: { available: false, enabled: false },
        location: locationDocument.defaultLocation,
        locationSource: 'global',
        objectCount: 0,
        readyCheckpointCount: 0,
        registryRevision: locationDocument.revision,
        state: 'missing',
      };
    }
    const { identity } = await inspectStorageIdentity(workspaceId);
    const selected = await locations.selection(workspaceId);
    const root = await locations.resolve(identity, selected.location);
    const stats = await statTree(root, fsPromises, pathModule).catch(() => ({ byteLength: 0, objectCount: 0 }));
    const objectStats = await statTree(pathModule.join(root, 'objects'), fsPromises, pathModule)
      .catch(() => ({ byteLength: 0, objectCount: 0 }));
    let checkpointCount = 0;
    let readyCheckpointCount = 0;
    let state: RecoveryStorageStatus['state'] = 'missing';
    let catalog: RecoveryStorageStatus['catalog'] = { currentSchemaVersion: 0, retiredCatalogCount: 0, state: 'missing' };
    // Use the read-only inspect path for status queries — this never
    // migrates, retires, or creates a catalog. It only classifies and,
    // for current v5 catalogs, opens a readonly handle to count rows.
    const inspected = await inspectRecoveryJournalCatalog(root, { fsPromises }).catch((error) => {
      if (errorCode(error) === 'storage-schema-newer') {
        state = 'corrupt';
      } else if (errorCode(error) === 'storage-malformed') {
        state = 'malformed';
      } else {
        state = 'corrupt';
      }
      return null;
    });
    if (inspected) {
      catalog = {
        currentSchemaVersion: inspected.status.currentSchemaVersion,
        retiredCatalogCount: inspected.status.retiredCatalogCount,
        state: inspected.status.state,
        ...('migratedFrom' in inspected.status && inspected.status.migratedFrom !== undefined
          ? { migratedFrom: inspected.status.migratedFrom }
          : {}),
      };
      if (inspected.database) {
        try {
          const counts = inspected.database.prepare(`
            SELECT COUNT(*) AS count,
              SUM(CASE WHEN state = 'ready' THEN 1 ELSE 0 END) AS ready
            FROM checkpoints WHERE workspace_id = ?
          `).get(workspaceId) as { count: number; ready: number | null };
          checkpointCount = counts.count;
          readyCheckpointCount = counts.ready ?? 0;
          state = 'ready';
        } finally {
          inspected.database.close();
        }
      } else if (inspected.classification.kind === 'migrate'
        || inspected.classification.kind === 'retire'
        || inspected.classification.kind === 'empty') {
        // Catalog exists but needs activation before it can be read.
        // Report it as 'ready' with zero counts — the caller can activate
        // by performing a write operation (createCheckpoint, etc).
        state = 'ready';
      }
    }
    return {
      authorityId,
      byteLength: stats.byteLength,
      catalog,
      checkpointCount,
      encryption: { available: false, enabled: false },
      location: selected.location,
      locationSource: selected.source,
      objectCount: objectStats.objectCount,
      readyCheckpointCount,
      registryRevision: selected.document.revision,
      state,
      workspaceId,
    };
  };

  const writeMoveOperation = (operation: MoveOperation): Promise<void> => writeRecoveryJsonAtomic(
    pathModule.join(locations.operationsRoot, `${operation.id}.json`),
    operation,
    { fsPromises, pathModule },
  );

  const moveStorageInternal = async (
    workspaceId: string,
    targetLocation: RecoveryStorageLocation,
    sourceKind: 'global' | 'workspace',
  ): Promise<MoveOperation> => {
    const identity = await inspectIdentity(workspaceId);
    const selected = await locations.selection(workspaceId);
    const from = selected.location;
    const to = await locations.validateLocation(targetLocation);
    const sourceRoot = await locations.resolve(identity, from);
    const destinationRoot = await locations.resolve(identity, to);
    const now = new Date().toISOString();
    const operation: MoveOperation = {
      byteLength: 0,
      from,
      id: randomUUID(),
      startedAt: now,
      state: 'copying',
      to,
      updatedAt: now,
      workspaceId,
    };
    await writeMoveOperation(operation);
    const staging = `${destinationRoot}.piarium-move-${operation.id}`;
    try {
      if (!locations.samePath(sourceRoot, destinationRoot)) {
        await fsPromises.rm(staging, { force: true, recursive: true });
        let sourceExists = true;
        try {
          await fsPromises.lstat(sourceRoot);
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
          sourceExists = false;
        }
        if (sourceExists) {
          await fsPromises.mkdir(pathModule.dirname(staging), { recursive: true });
          await fsPromises.cp(sourceRoot, staging, { recursive: true, errorOnExist: true, force: false });
          operation.byteLength = (await statTree(staging, fsPromises, pathModule)).byteLength;
          operation.state = 'verifying';
          operation.updatedAt = new Date().toISOString();
          await writeMoveOperation(operation);
          await verifyRecoveryJournalStore(staging, { fsPromises });
          try {
            await fsPromises.lstat(destinationRoot);
            throw new RecoveryPrimitiveError('storage-move-failed', `Recovery destination already exists: ${destinationRoot}`);
          } catch (error) {
            if (errorCode(error) !== 'ENOENT') throw error;
          }
          await fsPromises.rename(staging, destinationRoot);
        } else {
          await fsPromises.mkdir(destinationRoot, { recursive: true });
        }
        operation.state = 'switching';
        operation.updatedAt = new Date().toISOString();
        await writeMoveOperation(operation);
      }
      await locations.commit(workspaceId, from, to, {
        ...(sourceKind === 'global' ? { source: 'global', expectedDefaultLocation: to } : {}),
      });
      if (!locations.samePath(sourceRoot, destinationRoot)) {
        // The verified destination is authoritative after the registry switch.
        // Failure to remove the old copy must not turn a completed move into a
        // false rollback or make callers retry the already-committed decision.
        await fsPromises.rm(sourceRoot, { force: true, recursive: true }).catch(() => undefined);
      }
      operation.state = 'complete';
    } catch (error) {
      await fsPromises.rm(staging, { force: true, recursive: true }).catch(() => undefined);
      operation.failure = recoveryFailure(error, 'storage-move-failed');
      operation.state = 'failed';
    }
    operation.updatedAt = new Date().toISOString();
    await writeMoveOperation(operation);
    return operation;
  };

  const listStorageWorkspacesInternal = async (): Promise<RecoveryStorageWorkspaceSummary[]> => {
    const registrations = await documents.listWorkspaceRegistrations();
    const document = await locations.read();
    const known = new Map(registrations.map((entry) => [entry.workspaceId, entry]));
    for (const workspaceId of [...Object.keys(document.locations), ...Object.keys(document.inheritedLocations)]) {
      if (!known.has(workspaceId)) known.set(workspaceId, { canonicalPath: workspaceId, workspaceId });
    }
    const results: RecoveryStorageWorkspaceSummary[] = [];
    for (const entry of known.values()) {
      const selected = await locations.selection(entry.workspaceId);
      try {
        const storageIdentity = await inspectStorageIdentity(entry.workspaceId);
        const { identity } = storageIdentity;
        const status = await storageStatusInternal(entry.workspaceId);
        const storage = await storageFor(identity, false);
        let lastActivityAt: string | null = null;
        // Use the read-only inspect path for last-activity queries.
        const inspected = await inspectRecoveryJournalCatalog(storage.root, { fsPromises }).catch(() => null);
        if (inspected?.database) {
          try {
            const lastActivity = inspected.database.prepare(`
              SELECT MAX(value) AS value FROM (
                SELECT MAX(created_at) AS value FROM checkpoints WHERE workspace_id = ?
                UNION ALL SELECT MAX(updated_at) AS value FROM operations WHERE workspace_id = ?
              )
            `).get(entry.workspaceId, entry.workspaceId) as { value: string | null };
            lastActivityAt = lastActivity.value ?? null;
          } finally {
            inspected.database.close();
          }
        }
        results.push({
          byteLength: status.byteLength,
          catalog: status.catalog,
          canonicalRoot: identity.canonicalRoot,
          checkpointCount: status.checkpointCount,
          lastActivityAt,
          location: selected.location,
          locationSource: selected.source,
          migrationRequired: selected.migrationRequired,
          objectCount: status.objectCount,
          state: status.state,
          storageAvailable: true,
          workspaceAvailable: storageIdentity.workspaceAvailable,
          workspaceId: entry.workspaceId,
        });
      } catch (error) {
        results.push({
          byteLength: 0,
          catalog: { currentSchemaVersion: 0, retiredCatalogCount: 0, state: 'missing' },
          canonicalRoot: entry.canonicalPath,
          checkpointCount: 0,
          failure: recoveryFailure(error, 'unavailable'),
          lastActivityAt: null,
          location: selected.location,
          locationSource: selected.source,
          migrationRequired: selected.migrationRequired,
          objectCount: 0,
          state: 'unavailable',
          storageAvailable: false,
          workspaceAvailable: false,
          workspaceId: entry.workspaceId,
        });
      }
    }
    return results.sort((left, right) => String(right.lastActivityAt ?? '').localeCompare(String(left.lastActivityAt ?? '')));
  };

  const retentionPolicyFor = (database: SqliteDatabase, workspaceId: string): RecoveryRetentionPolicy => {
    const row = database.prepare('SELECT value FROM metadata WHERE key = ?')
      .get(retentionPolicyKey(workspaceId)) as { value: string } | undefined;
    if (!row) return { ...DEFAULT_RETENTION_POLICY };
    try {
      return parseRecoveryRetentionPolicy(JSON.parse(row.value) as unknown);
    } catch (error) {
      throw new RecoveryPrimitiveError('storage-malformed', 'Recovery retention policy is malformed', {
        cause: error,
        origin: 'storage',
      });
    }
  };

  const retentionStatusFor = (database: SqliteDatabase, workspaceId: string): RecoveryRetentionStatus => {
    const checkpoint = database.prepare(`
      SELECT
        SUM(CASE WHEN source = 'turn' AND state != 'pending' THEN 1 ELSE 0 END) AS eligible,
        SUM(CASE WHEN source != 'turn' OR state = 'pending' THEN 1 ELSE 0 END) AS protected,
        COALESCE(SUM(byte_length), 0) AS bytes
      FROM checkpoints WHERE workspace_id = ?
    `).get(workspaceId) as { bytes: number | null; eligible: number | null; protected: number | null };
    const operation = database.prepare(`
      SELECT
        SUM(CASE WHEN state IN ('complete', 'aborted', 'compensated') THEN 1 ELSE 0 END) AS terminal,
        SUM(CASE WHEN state NOT IN ('complete', 'aborted', 'compensated') THEN 1 ELSE 0 END) AS protected,
        MIN(CASE WHEN state NOT IN ('complete', 'aborted', 'compensated') THEN created_at END) AS oldest_protected
      FROM operations WHERE workspace_id = ? AND kind = 'combined'
    `).get(workspaceId) as {
      oldest_protected: string | null;
      protected: number | null;
      terminal: number | null;
    };
    const lastRun = database.prepare('SELECT value FROM metadata WHERE key = ?')
      .get(retentionRunKey(workspaceId)) as { value: string } | undefined;
    return {
      eligibleCheckpointCount: checkpoint.eligible ?? 0,
      lastRunAt: lastRun?.value ?? null,
      oldestProtectedOperationAt: operation.oldest_protected ?? null,
      policy: retentionPolicyFor(database, workspaceId),
      protectedCheckpointCount: checkpoint.protected ?? 0,
      protectedOperationCount: operation.protected ?? 0,
      retainedByteLength: checkpoint.bytes ?? 0,
      terminalOperationCount: operation.terminal ?? 0,
      workspaceId,
    };
  };

  const retentionEnabled = (policy: RecoveryRetentionPolicy): boolean => (
    Object.values(policy).some((value) => value !== null)
  );

  const pruneRetentionRecords = (
    database: SqliteDatabase,
    workspaceId: string,
  ): { policy: RecoveryRetentionPolicy; recordsDeleted: number } => {
    const policy = retentionPolicyFor(database, workspaceId);
    if (!retentionEnabled(policy)) return { recordsDeleted: 0, policy };
    const checkpoints = database.prepare(`
      SELECT id, created_at, byte_length
      FROM checkpoints
      WHERE workspace_id = ? AND source = 'turn' AND state != 'pending'
      ORDER BY sequence ASC
    `).all(workspaceId) as { byte_length: number; created_at: string; id: string }[];
    const operations = database.prepare(`
      SELECT id, updated_at, state
      FROM operations
      WHERE workspace_id = ? AND kind = 'combined'
      ORDER BY updated_at ASC, id ASC
    `).all(workspaceId) as { id: string; state: string; updated_at: string }[];
    const checkpointIds = new Set<string>();
    const operationIds = new Set<string>();
    let cutoff: string | null = null;
    if (policy.maxAgeDays !== null) {
      const ageMilliseconds = policy.maxAgeDays * 86_400_000;
      if (!Number.isSafeInteger(ageMilliseconds)) {
        throw new RecoveryPrimitiveError('invalid-request', 'Recovery retention age exceeds the supported timestamp range');
      }
      cutoff = new Date(Date.now() - ageMilliseconds).toISOString();
      for (const checkpoint of checkpoints) {
        if (checkpoint.created_at < cutoff) checkpointIds.add(checkpoint.id);
      }
      for (const operation of operations) {
        if (PRUNABLE_OPERATION_STATES.has(operation.state) && operation.updated_at < cutoff) {
          operationIds.add(operation.id);
        }
      }
    }
    if (policy.maxCheckpointCount !== null) {
      const excess = Math.max(0, checkpoints.length - policy.maxCheckpointCount);
      for (const checkpoint of checkpoints.slice(0, excess)) checkpointIds.add(checkpoint.id);
    }
    if (policy.maxByteLength !== null) {
      let retainedBytes = checkpoints.reduce((total, checkpoint) => total + checkpoint.byte_length, 0);
      for (const checkpoint of checkpoints) {
        if (retainedBytes <= policy.maxByteLength) break;
        checkpointIds.add(checkpoint.id);
        retainedBytes -= checkpoint.byte_length;
      }
    }
    if (policy.maxOperationCount !== null) {
      const prunable = operations.filter((operation) => PRUNABLE_OPERATION_STATES.has(operation.state));
      const excess = Math.max(0, prunable.length - policy.maxOperationCount);
      for (const operation of prunable.slice(0, excess)) operationIds.add(operation.id);
    }
    let recordsDeleted = 0;
    runImmediateTransaction(database, 'Recovery retention pruning', () => {
      for (const checkpointId of checkpointIds) {
        const changes = database.prepare('SELECT path FROM checkpoint_changes WHERE checkpoint_id = ?')
          .all(checkpointId) as { path: string }[];
        for (const change of changes) {
          deleteObjectReferences(
            database,
            workspaceId,
            'checkpoint-change',
            JSON.stringify([checkpointId, change.path]),
          );
        }
        recordsDeleted += database.prepare('DELETE FROM checkpoints WHERE id = ? AND workspace_id = ?')
          .run(checkpointId, workspaceId).changes;
      }
      for (const operationId of operationIds) {
        const files = database.prepare('SELECT path FROM operation_files WHERE operation_id = ?')
          .all(operationId) as { path: string }[];
        for (const file of files) {
          deleteObjectReferences(
            database,
            workspaceId,
            'operation-file',
            JSON.stringify([operationId, file.path]),
          );
        }
        deleteObjectReferences(database, workspaceId, 'operation', operationId);
        recordsDeleted += database.prepare(`
          DELETE FROM operations
          WHERE id = ? AND workspace_id = ? AND state IN ('complete', 'aborted', 'compensated')
        `).run(operationId, workspaceId).changes;
      }
      const lastRunAt = new Date().toISOString();
      database.prepare(`
        INSERT INTO metadata(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(retentionRunKey(workspaceId), lastRunAt);
    });
    return { recordsDeleted, policy };
  };

  const referencedObjects = (database: SqliteDatabase): Set<string> => new Set(
    database.prepare('SELECT DISTINCT object_hash FROM object_references')
      .all().map((row) => (row as { object_hash: string }).object_hash),
  );

  const collectUnreachableObjects = async (
    root: string,
    database: SqliteDatabase,
  ): Promise<{ byteLengthReclaimed: number; objectsDeleted: number }> => {
    const refs = referencedObjects(database);
    const objectsRoot = pathModule.join(root, 'objects');
    let byteLengthReclaimed = 0;
    let objectsDeleted = 0;
    const walk = async (directory: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fsPromises.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        const target = pathModule.join(directory, entry.name);
        if (entry.isDirectory()) await walk(target);
        else if (entry.isFile()) {
          const relative = pathModule.relative(objectsRoot, target).replace(/[\\/]/g, '');
          if (refs.has(`sha256-${relative}`)) continue;
          byteLengthReclaimed += (await fsPromises.stat(target)).size;
          await fsPromises.rm(target, { force: true });
          objectsDeleted += 1;
        }
      }
    };
    await walk(objectsRoot);
    return { byteLengthReclaimed, objectsDeleted };
  };

  const retentionStatusInternal = async (workspaceId: string): Promise<RecoveryRetentionStatus> => {
    const { identity } = await inspectStorageIdentity(workspaceId);
    const storage = await storageFor(identity, false);
    const inspected = await inspectRecoveryJournalCatalog(storage.root, { fsPromises });
    if (!inspected?.database) {
      return {
        eligibleCheckpointCount: 0,
        lastRunAt: null,
        oldestProtectedOperationAt: null,
        policy: { ...DEFAULT_RETENTION_POLICY },
        protectedCheckpointCount: 0,
        protectedOperationCount: 0,
        retainedByteLength: 0,
        terminalOperationCount: 0,
        workspaceId,
      };
    }
    const database = inspected.database;
    try {
      return retentionStatusFor(database, workspaceId);
    } finally {
      database.close();
    }
  };

  const setRetentionPolicyInternal = async (
    input: RecoveryRetentionPolicyInput,
  ): Promise<RecoveryRetentionStatus> => {
    const { identity } = await inspectStorageIdentity(input.workspaceId);
    const storage = await storageFor(identity, true);
    const database = await openWritableCatalog(storage.root);
    try {
      runImmediateTransaction(database, 'Recovery retention policy update', () => {
        database.prepare(`
          INSERT INTO metadata(key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(retentionPolicyKey(input.workspaceId), JSON.stringify(input.policy));
      });
      pruneRetentionRecords(database, input.workspaceId);
      await collectUnreachableObjects(storage.root, database);
      return retentionStatusFor(database, input.workspaceId);
    } finally {
      database.close();
    }
  };

  const cleanupStorageInternal = async (
    workspaceId: string,
    options: { scanUnchangedObjects?: boolean | undefined } = {},
  ): Promise<RecoveryStorageCleanupResult> => {
    const { identity } = await inspectStorageIdentity(workspaceId);
    const storage = await storageFor(identity, false);
    const database = await openRecoveryJournalCatalog(storage.root, { create: false, fsPromises });
    const operationId = randomUUID();
    if (!database) return { byteLengthReclaimed: 0, failures: [], objectsDeleted: 0, operationId, recordsDeleted: 0, status: 'complete', workspaceId };
    try {
      const { recordsDeleted } = pruneRetentionRecords(database, workspaceId);
      const { byteLengthReclaimed, objectsDeleted } = recordsDeleted > 0 || options.scanUnchangedObjects !== false
        ? await collectUnreachableObjects(storage.root, database)
        : { byteLengthReclaimed: 0, objectsDeleted: 0 };
      return { byteLengthReclaimed, failures: [], objectsDeleted, operationId, recordsDeleted, status: 'complete', workspaceId };
    } finally {
      database.close();
    }
  };

  const deleteWorkspaceHistoryInternal = async (workspaceId: string): Promise<RecoveryStorageCleanupResult> => {
    const { identity } = await inspectStorageIdentity(workspaceId);
    const storage = await storageFor(identity, false);
    const database = await openRecoveryJournalCatalog(storage.root, { create: false, fsPromises });
    const operationId = randomUUID();
    if (!database) {
      return { byteLengthReclaimed: 0, failures: [], objectsDeleted: 0, operationId, recordsDeleted: 0, status: 'complete', workspaceId };
    }
    try {
      let recordsDeleted = 0;
      runImmediateTransaction(database, 'Workspace history deletion', () => {
        // Delete only this workspace's rows. Other workspaces sharing the same
        // physical store keep their data. Cascade deletes handle checkpoint_changes
        // via foreign keys; operations are deleted directly.
        const checkpointIds = database.prepare(
          'SELECT id FROM checkpoints WHERE workspace_id = ?',
        ).all(workspaceId).map((row) => (row as { id: string }).id);
        // Delete checkpoint_changes for this workspace's checkpoints.
        if (checkpointIds.length > 0) {
          const placeholders = checkpointIds.map(() => '?').join(', ');
          database.prepare(`DELETE FROM checkpoint_changes WHERE checkpoint_id IN (${placeholders})`)
            .run(...checkpointIds);
        }
        // Delete turn_bindings for this workspace.
        const bindingsResult = database.prepare('DELETE FROM turn_bindings WHERE workspace_id = ?').run(workspaceId);
        recordsDeleted += bindingsResult.changes;
        // Delete checkpoints for this workspace.
        const checkpointsResult = database.prepare('DELETE FROM checkpoints WHERE workspace_id = ?').run(workspaceId);
        recordsDeleted += checkpointsResult.changes;
        // Delete operations for this workspace.
        const operationsResult = database.prepare("DELETE FROM operations WHERE workspace_id = ? AND kind = 'combined'").run(workspaceId);
        recordsDeleted += operationsResult.changes;
        database.prepare('DELETE FROM object_references WHERE workspace_id = ?').run(workspaceId);
        database.prepare('DELETE FROM metadata WHERE key IN (?, ?)')
          .run(retentionPolicyKey(workspaceId), retentionRunKey(workspaceId));
        // Rebuild object_references from remaining source rows so refs owned by
        // deleted checkpoints/operations are removed cleanly without LIKE matching.
        // better-sqlite3 uses SAVEPOINTs for nested transactions, so this is safe
        // inside the outer immediate transaction.
        rebuildObjectReferences(database);
      });
      // GC unreachable objects after row deletion.
      const { byteLengthReclaimed, objectsDeleted } = await collectUnreachableObjects(storage.root, database);
      return { byteLengthReclaimed, failures: [], objectsDeleted, operationId, recordsDeleted, status: 'complete', workspaceId };
    } finally {
      database.close();
    }
  };

  // Reconcile a single operation file's phase against its on-disk state
  // after a crash. The crash window is:
  //   apply-intent: file was about to be written. Disk could be safety
  //                 (not yet written), target (written but phase not updated),
  //                 or something else (concurrent modification).
  //   compensate-intent: file was about to be restored to safety. Disk could
  //                 be target (not yet compensated), safety (compensated but
  //                 phase not updated), or something else.
  // In each case, we update the phase to reflect the actual disk state so
  // resume can proceed correctly. If disk doesn't match either expected
  // state, the file goes to needs-attention.
  const reconcileOperationFile = async (
    record: CombinedOperationRecord,
    fileRow: OperationFileRow,
    identity: RecoveryIdentity,
    root: string,
    database: SqliteDatabase,
  ): Promise<OperationFilePhase> => {
    const relativePath = fileRow.path;
    const states = record.targets[relativePath];
    if (!states) {
      updateOperationFilePhase(database, record.id, relativePath, 'needs-attention');
      return 'needs-attention';
    }
    const current = (await fileStore.captureState(identity, root, relativePath, { store: false })).state;
    if (fileRow.phase === 'apply-intent') {
      if (sameState(current, states.target)) {
        // File was written but phase wasn't updated — treat as applied.
        updateOperationFilePhase(database, record.id, relativePath, 'target-observed');
        return 'target-observed';
      }
      if (sameState(current, safetyStateFor(record, relativePath))) {
        // File wasn't written yet — still at safety, safe to abort.
        return 'apply-intent';
      }
      // Disk is in an unknown state — needs attention.
      updateOperationFilePhase(database, record.id, relativePath, 'needs-attention');
      return 'needs-attention';
    }
    if (fileRow.phase === 'compensate-intent') {
      if (sameState(current, safetyStateFor(record, relativePath))) {
        // Compensation was written but phase wasn't updated.
        updateOperationFilePhase(database, record.id, relativePath, 'safety-observed');
        return 'safety-observed';
      }
      if (sameState(current, states.target)) {
        // Compensation wasn't written yet — still at target.
        return 'compensate-intent';
      }
      updateOperationFilePhase(database, record.id, relativePath, 'needs-attention');
      return 'needs-attention';
    }
    return fileRow.phase;
  };

  const resumeUnfinished = async (): Promise<WorkspaceCombinedRecoveryOperation[]> => {
    const registrations = await documents.listWorkspaceRegistrations();
    const resolved: WorkspaceCombinedRecoveryOperation[] = [];
    for (const registration of registrations) {
      const workspaceId = registration.workspaceId;
      const identity = await inspectIdentity(workspaceId).catch((error) => {
        const failures = startupFailures.get(workspaceId) ?? [];
        failures.push(recoveryFailure(error, 'unavailable'));
        startupFailures.set(workspaceId, failures);
        return null;
      });
      if (!identity) continue;
      const storage = await storageFor(identity, false).catch(() => null);
      if (!storage) continue;
      let workspaceLease: Awaited<ReturnType<typeof leases.acquire>>;
      try {
        workspaceLease = await leases.acquire({
          root: storage.root,
          workspaceId,
          mode: 'exclusive',
          purpose: 'recovery-crash-reconciliation',
        });
      } catch (error) {
        const failures = startupFailures.get(workspaceId) ?? [];
        failures.push(recoveryFailure(error, 'lease-unavailable'));
        startupFailures.set(workspaceId, failures);
        continue;
      }
      const database = await openRecoveryJournalCatalog(storage.root, { create: false, fsPromises }).catch((error) => {
        const failures = startupFailures.get(workspaceId) ?? [];
        failures.push(recoveryFailure(error, 'storage-malformed'));
        startupFailures.set(workspaceId, failures);
        return null;
      });
      if (!database) {
        await workspaceLease.release().catch((error) => rememberLeaseReleaseFailure(workspaceId, error));
        continue;
      }
      try {
        const rows = database.prepare(`
          SELECT * FROM operations WHERE kind = 'combined'
          AND state NOT IN ('complete', 'aborted', 'compensated', 'needs-attention')
        `).all() as OperationRow[];
        for (const row of rows) {
          const record = parseCombinedOperationRecord(row);
          if (record.state === 'planned') continue;
          try {
            // Reconcile each file's phase against its on-disk state.
            // This closes the crash window between writing the file and
            // updating the phase row.
            const fileRows = operationFileRows(database, record.id);
            const reconciledPhases: OperationFilePhase[] = [];
            for (const fileRow of fileRows) {
              if (fileRow.phase === 'apply-intent' || fileRow.phase === 'compensate-intent') {
                const phase = await reconcileOperationFile(record, fileRow, identity, storage.root, database);
                reconciledPhases.push(phase);
              } else {
                reconciledPhases.push(fileRow.phase);
              }
            }
            // If any file is needs-attention, the operation must go to
            // needs-attention — it cannot be silently aborted.
            if (reconciledPhases.includes('needs-attention')) {
              record.failure = recoveryFailure(
                new RecoveryPrimitiveError('needs-attention', 'Operation has files in an unreconcilable state after crash', {
                  origin: 'storage',
                }),
                'needs-attention',
              );
              record.fileState = 'needs-attention';
              record.state = 'needs-attention';
              persistOperation(database, record);
              resolved.push(publicOperation(record));
              continue;
            }
            const hasAppliedFiles = reconciledPhases.includes('target-observed');
            const hasCompensatingFiles = reconciledPhases.includes('compensate-intent');
            const hasSafetyObserved = reconciledPhases.includes('safety-observed');
            const hasSafetyCaptured = reconciledPhases.includes('apply-intent')
              || hasAppliedFiles;
            if (hasCompensatingFiles || (hasAppliedFiles && Object.keys(record.safety ?? {}).length > 0)) {
              await compensate(record, identity, storage.root, database);
            } else if (hasSafetyObserved && !hasAppliedFiles && !hasCompensatingFiles) {
              // All files are safety-observed — compensation already complete.
              record.fileState = 'compensated';
              record.state = 'compensated';
              persistOperation(database, record);
            } else if (hasSafetyCaptured && Object.keys(record.safety ?? {}).length > 0) {
              // Safety was captured but no files were applied yet — safe to abort.
              record.state = 'aborted';
              persistOperation(database, record);
            } else {
              record.state = 'aborted';
              persistOperation(database, record);
            }
          } catch (error) {
            record.failure = recoveryFailure(error, 'needs-attention');
            record.fileState = 'needs-attention';
            record.state = 'needs-attention';
            persistOperation(database, record);
          }
          resolved.push(publicOperation(record));
        }
      } finally {
        database.close();
        await workspaceLease.release().catch((error) => rememberLeaseReleaseFailure(workspaceId, error));
      }
    }
    return resolved;
  };

  const safe = async <T>(
    operation: () => Promise<T>,
    fallbackCode: WorkspaceRecoveryFailureCode = 'internal',
  ): Promise<T | WorkspaceRecoveryFailedResult> => {
    try {
      return await operation();
    } catch (error) {
      return failedRecoveryResult(error, fallbackCode);
    }
  };

  const scheduleAutomaticRetention = (workspaceId: string): void => {
    void retentionStatusInternal(workspaceId).then((retention) => {
      if (!retentionEnabled(retention.policy) || disposed) return;
      return runWorkspace(
        workspaceId,
        () => cleanupStorageInternal(workspaceId, { scanUnchangedObjects: false }),
        { mode: 'exclusive', purpose: 'recovery-retention-automatic' },
      );
    }).catch((error) => {
      if (errorCode(error) === 'lease-unavailable') return;
      const failures = startupFailures.get(workspaceId) ?? [];
      failures.push(recoveryFailure(error, 'internal'));
      startupFailures.set(workspaceId, failures);
    });
  };

  return {
    locations,
    applyCombinedRecovery: (input: WorkspaceCombinedRecoveryApplyInput) => safe(async () => {
      const located = await locateOperation(input.operationId);
      return {
        operation: await runWorkspace(located.identity.workspaceId, async () => (
          applyLocatedOperation(await locateOperation(input.operationId), input)
        ), { mode: 'exclusive', purpose: 'combined-recovery-apply' }),
        status: 'ready',
      };
    }),
    cancelCombinedOperation: (operationId: string) => safe(async () => {
      const located = await locateOperation(operationId);
      return {
        operation: await runWorkspace(
          located.identity.workspaceId,
          () => cancelOperationInternal(operationId),
          { mode: 'shared', purpose: 'combined-recovery-cancel' },
        ),
        status: 'ready',
      };
    }),
    clearStorageLocationOverride: (workspaceId: string) => safe(() => runWorkspace(workspaceId, async () => {
      const global = await locations.globalSelection();
      return { operation: await moveStorageInternal(workspaceId, global.location, 'global'), status: 'ready' };
    }, { mode: 'exclusive', purpose: 'recovery-storage-move' })),
    cleanupStorage: (input: RecoveryStorageCleanupInput) => safe(() => runWorkspace(input.workspaceId, async () => ({
      result: await cleanupStorageInternal(input.workspaceId),
      status: 'ready',
    }), { mode: 'exclusive', purpose: 'recovery-retention-cleanup' })),
    createCheckpoint: (input: WorkspaceRecoveryCheckpointInput) => safe(async () => ({ checkpoint: await runWorkspace(input.workspaceId, () => createCheckpointInternal(input)), status: 'ready' })),
    deleteWorkspaceHistory: (workspaceId: string) => safe(() => runWorkspace(workspaceId, async () => ({
      result: await deleteWorkspaceHistoryInternal(workspaceId),
      status: 'ready',
    }), { mode: 'exclusive', purpose: 'recovery-history-delete' })),
    fenceUnfinishedOperations: resumeUnfinished,
    getCombinedOperation: (operationId: string) => safe(async () => ({ operation: await getOperationInternal(operationId), status: 'ready' })),
    getStorageMove: (operationId: string) => safe(async () => ({
      operation: parseRecoveryStorageMoveOperation(await readRecoveryJsonAtomic(
        pathModule.join(locations.operationsRoot, `${operationId}.json`),
        { fsPromises },
      )),
      status: 'ready',
    })),
    listCheckpoints: (input: WorkspaceRecoveryCheckpointQuery) => safe(async () => ({ page: await listCheckpointsInternal(input), status: 'ready' })),
    listCombinedOperations: (workspaceId: string) => safe(async () => ({ operations: await listOperationsInternal(workspaceId), status: 'ready' })),
    listStorageWorkspaces: () => safe(async () => ({ status: 'ready', workspaces: await listStorageWorkspacesInternal() })),
    prepareCombinedRecovery: (input: WorkspaceCombinedRecoveryPrepareInput) => safe(async () => ({
      plan: await runWorkspace(
        input.workspaceId,
        () => prepareCombinedInternal(input),
        { mode: 'shared', purpose: 'combined-recovery-prepare' },
      ),
      status: 'ready',
    })),
    prepareCombinedUndo: (operationId: string) => safe(async () => {
      const located = await locateOperation(operationId);
      return {
        plan: await runWorkspace(
          located.identity.workspaceId,
          () => prepareUndoInternal(operationId),
          { mode: 'shared', purpose: 'combined-recovery-undo-prepare' },
        ),
        status: 'ready',
      };
    }),
    recordMutationAfter: (input: WorkspaceRecoveryMutationAfterInput) => safe(async () => ({
      recorded: await runWorkspace(
        input.workspaceId,
        () => recordMutationAfterInternal(input),
        { mode: 'shared', purpose: 'recovery-journal-after-image' },
      ),
      status: 'ready',
    })),
    recordMutationBefore: (input: WorkspaceRecoveryMutationBeforeInput) => safe(async () => ({
      recorded: await runWorkspace(
        input.workspaceId,
        () => recordMutationBeforeInternal(input),
        { mode: 'shared', purpose: 'recovery-journal-before-image' },
      ),
      status: 'ready',
    })),
    recordTurnSettled: (input: WorkspaceRecoveryTurnSettledInput) => safe(async () => {
      const binding = await runWorkspace(input.workspaceId, () => recordTurnSettledInternal(input));
      scheduleAutomaticRetention(input.workspaceId);
      return { binding, status: 'ready' };
    }),
    recordTurnStart: (input: WorkspaceRecoveryTurnStartInput) => safe(async () => ({ binding: await runWorkspace(input.workspaceId, () => recordTurnStartInternal(input)), status: 'ready' })),
    retentionStatus: (workspaceId: string) => safe(async () => ({
      retention: await retentionStatusInternal(workspaceId),
      status: 'ready',
    })),
    resolveEntry: (input: WorkspaceRecoveryEntryTarget) => safe(() => resolveEntryInternal(input)),
    resumeCombinedOperations: resumeUnfinished,
    resumeWorkspaceOperations: async () => [],
    setDefaultStorageLocation: (location: RecoveryStorageLocation) => safe(async () => {
      await locations.setDefault(await locations.validateLocation(location));
      return { status: 'ready', storage: await storageStatusInternal() };
    }),
    setRetentionPolicy: (input: RecoveryRetentionPolicyInput) => safe(() => runWorkspace(input.workspaceId, async () => ({
      retention: await setRetentionPolicyInternal(input),
      status: 'ready',
    }), { mode: 'exclusive', purpose: 'recovery-retention-policy' })),
    setStorageLocation: (input: SetRecoveryStorageLocationInput) => safe(() => runWorkspace(input.workspaceId, async () => ({
      operation: await moveStorageInternal(input.workspaceId, input.location, 'workspace'),
      status: 'ready',
    }), { mode: 'exclusive', purpose: 'recovery-storage-move' })),
    status: (workspaceId: string) => safe(async () => {
      const [storage, retention] = await Promise.all([
        storageStatusInternal(workspaceId),
        retentionStatusInternal(workspaceId),
      ]);
      return {
        capabilities: {
          bindings: true,
          catalogLifecycle: true,
          checkpoints: true,
          combined: true,
          conflictConfirmation: true,
          dirtyStateBarrier: typeof documents.beginDirtyStateBarrier === 'function',
          journal: true,
          redo: true,
          retention: true,
          storageManagement: true,
          workspaceLease: true,
        },
        failures: startupFailures.get(workspaceId) ?? [],
        identity: await inspectIdentity(workspaceId),
        retention,
        status: 'ready',
        storage,
      };
    }),
    storageStatus: (workspaceId?: string) => safe(async () => ({ status: 'ready', storage: await storageStatusInternal(workspaceId) })),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await Promise.allSettled([...queues.values()]);
      await leases.dispose();
    },
  };
};
