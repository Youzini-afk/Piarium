import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceCombinedRecoveryApplyInput,
  WorkspaceCombinedRecoveryPrepareInput,
  WorkspaceRecoveryCheckpointQuery,
  WorkspaceRecoveryTurnSettledInput,
} from '@piarium/extension-contract';
import type { DocumentAuthorityOptions } from '../documents/authority.js';
import {
  createDocumentAuthorityHarness,
  type DocumentAuthorityHarness,
} from '../documents/contract-fixtures.js';
import {
  createWorkspaceRecoveryEngine,
  type CreateWorkspaceRecoveryEngineOptions,
  type RecoverySessionNavigation,
  type WorkspaceRecoveryEngine,
} from './engine.js';
import type { SqliteDatabase } from './journal-catalog.js';
import type { RecoveryFileStore } from './journal-files.js';

const harnesses = new Set<DocumentAuthorityHarness>();

type Ready<T> = Extract<T, { status: 'ready' }>;

const ready = <T extends { status: string }>(result: T): Ready<T> => {
  if (result.status !== 'ready') {
    throw new Error(`Expected ready recovery result, received ${result.status}`);
  }
  return result as Ready<T>;
};

const requireValue = <T>(value: T | null | undefined, label: string): T => {
  if (value === null || value === undefined) throw new Error(`${label} is required`);
  return value;
};

const createTestNavigation = (): RecoverySessionNavigation => ({
  commit: vi.fn(async () => ({ markerId: 'marker-1' })),
  commitLeaf: vi.fn(async () => ({ markerId: 'marker-undo' })),
  prepare: vi.fn(async (input) => ({
    editorText: 'draft',
    expectedLeafId: 'leaf-current',
    removedEntryIds: [input.entryId, 'assistant-1'],
    targetLeafId: 'leaf-before',
  })),
  prepareLeaf: vi.fn(async (input) => ({
    expectedLeafId: 'leaf-before',
    removedEntryIds: [],
    targetLeafId: input.targetLeafId,
  })),
});

type HarnessOptions = Partial<Omit<
  CreateWorkspaceRecoveryEngineOptions,
  'authorityId' | 'dataDir' | 'documents' | 'sessionNavigation'
>> & {
  documentAuthority?: Partial<Omit<DocumentAuthorityOptions, 'dataDir' | 'hostId'>> | undefined;
  sessionNavigation?: RecoverySessionNavigation | undefined;
};

const createHarness = async (options: HarnessOptions = {}): Promise<{
  engine: WorkspaceRecoveryEngine;
  harness: DocumentAuthorityHarness;
  navigation: RecoverySessionNavigation;
}> => {
  const { documentAuthority, sessionNavigation, ...engineOptions } = options;
  const harness = await createDocumentAuthorityHarness(
    documentAuthority ? { authority: documentAuthority } : undefined,
  );
  harnesses.add(harness);
  const navigation = sessionNavigation ?? createTestNavigation();
  const engine = createWorkspaceRecoveryEngine({
    authorityId: harness.authority.hostId,
    dataDir: harness.dataDir,
    documents: harness.authority,
    sessionNavigation: navigation,
    ...engineOptions,
  });
  return { engine, harness, navigation };
};

const startTurn = (engine: WorkspaceRecoveryEngine, harness: DocumentAuthorityHarness, suffix = '1') => engine.recordTurnStart({
  activeWriterScopes: [],
  executionId: `execution-${suffix}`,
  provenance: 'caused-by',
  runtimeGeneration: 1,
  sessionId: 'session-1',
  userEntryId: `user-${suffix}`,
  workerId: 'worker-1',
  workspaceId: harness.identity.workspaceId,
});

type SettleTurnOptions = Partial<Pick<
  WorkspaceRecoveryTurnSettledInput,
  'assistantEntryId' | 'executionId' | 'mutationObserved' | 'observationComplete' | 'observedResourceIds'
>>;

const settleTurn = (
  engine: WorkspaceRecoveryEngine,
  harness: DocumentAuthorityHarness,
  options: SettleTurnOptions = {},
) => engine.recordTurnSettled({
  activeWriterScopes: [],
  assistantEntryId: options.assistantEntryId ?? 'assistant-1',
  executionId: options.executionId ?? 'execution-1',
  mutationObserved: options.mutationObserved ?? true,
  observationComplete: options.observationComplete ?? true,
  observedResourceIds: options.observedResourceIds ?? ['note.txt'],
  provenance: 'caused-by',
  workspaceId: harness.identity.workspaceId,
});

const recordWrite = async (
  engine: WorkspaceRecoveryEngine,
  harness: DocumentAuthorityHarness,
  content: string,
): Promise<void> => {
  const target = path.join(harness.workspaceRoot, 'note.txt');
  const base = {
    executionId: 'execution-1',
    mutationId: 'mutation-1',
    path: target,
    toolCallId: 'tool-1',
    toolName: 'write' as const,
    workspaceId: harness.identity.workspaceId,
  };
  expect(await engine.recordMutationBefore(base)).toMatchObject({ recorded: true, status: 'ready' });
  await fs.promises.writeFile(target, content);
  expect(await engine.recordMutationAfter({ ...base, succeeded: true }))
    .toMatchObject({ recorded: true, status: 'ready' });
};

const prepareCombined = async (
  engine: WorkspaceRecoveryEngine,
  input: WorkspaceCombinedRecoveryPrepareInput,
): Promise<Ready<Awaited<ReturnType<WorkspaceRecoveryEngine['prepareCombinedRecovery']>>>> => (
  ready(await engine.prepareCombinedRecovery(input))
);

const applyCombined = async (
  engine: WorkspaceRecoveryEngine,
  input: WorkspaceCombinedRecoveryApplyInput,
) => ready(await engine.applyCombinedRecovery(input));

const listCheckpoints = async (
  engine: WorkspaceRecoveryEngine,
  input: WorkspaceRecoveryCheckpointQuery,
): Promise<Ready<Awaited<ReturnType<WorkspaceRecoveryEngine['listCheckpoints']>>>> => (
  ready(await engine.listCheckpoints(input))
);

const requireDatabase = (database: SqliteDatabase | null): SqliteDatabase => (
  requireValue(database, 'Recovery catalog')
);

const recoveryIdentity = (harness: DocumentAuthorityHarness) => ({
  canonicalRoot: harness.workspaceRoot,
  workspaceId: harness.identity.workspaceId,
});

const objectHashFromJson = (raw: string): string | null => {
  const value = JSON.parse(raw) as unknown;
  return value && typeof value === 'object' && 'objectHash' in value
    && typeof (value as { objectHash?: unknown }).objectHash === 'string'
    ? (value as { objectHash: string }).objectHash
    : null;
};

interface DirtyBarrierEvent {
  action: 'acquire' | 'release';
  barrierId: string;
}

const isDirtyBarrierEvent = (event: unknown): event is DirtyBarrierEvent => (
  event !== null
  && typeof event === 'object'
  && 'action' in event
  && ((event as { action?: unknown }).action === 'acquire' || (event as { action?: unknown }).action === 'release')
  && 'barrierId' in event
  && typeof (event as { barrierId?: unknown }).barrierId === 'string'
);

afterEach(async () => {
  await Promise.all([...harnesses].map((harness) => harness.cleanup()));
  harnesses.clear();
});

describe('affected-file workspace recovery journal', () => {
  it('creates a turn checkpoint without scanning unrelated workspace files', async () => {
    const createReadStream = vi.fn(fs.createReadStream.bind(fs));
    const { engine, harness } = await createHarness({ fsModule: { ...fs, createReadStream } });
    await Promise.all(Array.from({ length: 200 }, (_, index) => (
      fs.promises.writeFile(path.join(harness.workspaceRoot, `unrelated-${index}.txt`), 'large workspace data')
    )));

    await startTurn(engine, harness);
    await settleTurn(engine, harness, {
      mutationObserved: false,
      observationComplete: false,
      observedResourceIds: [],
    });

    expect(createReadStream).not.toHaveBeenCalled();
    const listed = await listCheckpoints(engine, { workspaceId: harness.identity.workspaceId });
    expect(listed).toMatchObject({
      status: 'ready',
      page: { checkpoints: [{ changedPathCount: 0, state: 'ready' }] },
    });
  });

  it('records only the first before-image and restores the affected path with the conversation', async () => {
    const { engine, harness, navigation } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);

    const prepared = await prepareCombined(engine, {
      entryId: 'user-1',
      sessionId: 'session-1',
      workspaceId: harness.identity.workspaceId,
    });
    expect(prepared).toMatchObject({
      status: 'ready',
      plan: { affectedPaths: ['note.txt'], conflicts: [], coverage: 'ready', uncoveredPaths: [] },
    });
    const applied = await applyCombined(engine, {
      confirmedConflicts: [],
      conflictPolicy: 'abort',
      expectedRevision: prepared.plan.revision,
      operationId: prepared.plan.id,
    });
    expect(applied).toMatchObject({
      status: 'ready',
      operation: { conversationState: 'navigated', fileState: 'restored', state: 'complete' },
    });
    expect(await fs.promises.readFile(target, 'utf8')).toBe('before');
    expect(navigation.commit).toHaveBeenCalledOnce();
  });

  it('waits for connected document surfaces before inspecting and applying recovery', async () => {
    const { engine, harness } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);
    const events: DirtyBarrierEvent[] = [];
    const surface = harness.authority.registerDirtySurface({
      generation: 1,
      ownerId: 'surface-1',
      workspaceId: harness.identity.workspaceId,
    }, (event) => {
      if (!isDirtyBarrierEvent(event)) return;
      events.push(event);
      if (event.action !== 'acquire') return;
      void (async () => {
        await harness.authority.publishDirtyBuffers({
          generation: 1,
          ownerId: 'surface-1',
          resources: [],
          workspaceId: harness.identity.workspaceId,
        });
        await harness.authority.acknowledgeDirtyStateBarrier({
          barrierId: event.barrierId,
          generation: 1,
          ownerId: 'surface-1',
          workspaceId: harness.identity.workspaceId,
        });
      })();
    });
    try {
      const prepared = await prepareCombined(engine, {
        entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
      });
      expect(prepared).toMatchObject({ status: 'ready', plan: { conflicts: [] } });
      const applied = await applyCombined(engine, {
        confirmedConflicts: [],
        conflictPolicy: 'abort',
        expectedRevision: prepared.plan.revision,
        operationId: prepared.plan.id,
      });
      expect(applied).toMatchObject({ status: 'ready', operation: { state: 'complete' } });
      expect(events.filter((event) => event.action === 'acquire')).toHaveLength(2);
      expect(events.filter((event) => event.action === 'release')).toHaveLength(2);
    } finally {
      surface.close();
    }
  });

  it('fails retryably instead of treating an unresponsive dirty surface as clean', async () => {
    const { engine, harness } = await createHarness({
      documentAuthority: { dirtyBarrierTimeoutMs: 20 },
    });
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);
    const events: unknown[] = [];
    const surface = harness.authority.registerDirtySurface({
      generation: 1,
      ownerId: 'unresponsive-surface',
      workspaceId: harness.identity.workspaceId,
    }, (event) => events.push(event));
    try {
      expect(await engine.prepareCombinedRecovery({
        entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
      })).toMatchObject({
        status: 'failed',
        failure: { code: 'dirty-state-unavailable', retryable: true },
      });
      expect(events).toContainEqual(expect.objectContaining({ action: 'release' }));
    } finally {
      surface.close();
    }
  });

  it('keeps the first before-image and last after-image across repeated writes in one turn', async () => {
    const { engine, harness } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'original');
    await startTurn(engine, harness);
    const base = {
      executionId: 'execution-1',
      path: target,
      toolCallId: 'tool-1',
      toolName: 'edit' as const,
      workspaceId: harness.identity.workspaceId,
    };
    await engine.recordMutationBefore({ ...base, mutationId: 'mutation-1' });
    await fs.promises.writeFile(target, 'middle');
    await engine.recordMutationAfter({ ...base, mutationId: 'mutation-1', succeeded: true });
    await engine.recordMutationBefore({ ...base, mutationId: 'mutation-2', toolCallId: 'tool-2' });
    await fs.promises.writeFile(target, 'final');
    await engine.recordMutationAfter({
      ...base,
      mutationId: 'mutation-2',
      succeeded: true,
      toolCallId: 'tool-2',
    });
    await settleTurn(engine, harness);

    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
    });
    await engine.applyCombinedRecovery({
      confirmedConflicts: [],
      conflictPolicy: 'abort', expectedRevision: prepared.plan.revision, operationId: prepared.plan.id,
    });
    expect(await fs.promises.readFile(target, 'utf8')).toBe('original');
  });

  it('turns an unchanged response into an immediate zero-file rollback', async () => {
    const { engine, harness } = await createHarness();
    await startTurn(engine, harness);
    await settleTurn(engine, harness, {
      mutationObserved: false,
      observationComplete: false,
      observedResourceIds: [],
    });
    const prepared = await prepareCombined(engine, {
      entryId: 'user-1',
      sessionId: 'session-1',
      workspaceId: harness.identity.workspaceId,
    });
    expect(prepared.plan).toMatchObject({ affectedPaths: [], changedBytes: 0, coverage: 'ready' });
    const applied = await applyCombined(engine, {
      confirmedConflicts: [],
      conflictPolicy: 'abort',
      expectedRevision: prepared.plan.revision,
      operationId: prepared.plan.id,
    });
    expect(applied.operation).toMatchObject({ fileState: 'unchanged', state: 'complete' });
  });

  it('keeps a journalled write with no net content change exact but out of the restore plan', async () => {
    const { engine, harness } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'same');
    await startTurn(engine, harness);
    const mutation = {
      executionId: 'execution-1', mutationId: 'mutation-same', path: target,
      toolCallId: 'tool-same', toolName: 'write' as const, workspaceId: harness.identity.workspaceId,
    };
    expect(await engine.recordMutationBefore(mutation)).toMatchObject({ recorded: true });
    await fs.promises.writeFile(target, 'same');
    expect(await engine.recordMutationAfter({ ...mutation, succeeded: true }))
      .toMatchObject({ recorded: false });
    await settleTurn(engine, harness);
    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
    });
    expect(prepared.plan).toMatchObject({ affectedPaths: [], coverage: 'ready' });
  });

  it('rejects an absolute mutation path that does not resolve inside the workspace', async () => {
    const { engine, harness } = await createHarness();
    await startTurn(engine, harness);

    const result = await engine.recordMutationBefore({
      executionId: 'execution-1',
      mutationId: 'mutation-outside',
      path: path.join(harness.root, 'outside.txt'),
      toolCallId: 'tool-outside',
      toolName: 'write' as const,
      workspaceId: harness.identity.workspaceId,
    });

    expect(result).toMatchObject({
      failure: { code: 'workspace-untrusted', retryable: false },
      status: 'failed',
    });
  });

  it('detects later user edits per path and overwrites only after an explicit choice', async () => {
    const { engine, harness } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'agent');
    await settleTurn(engine, harness);
    await fs.promises.writeFile(target, 'user-later');

    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
    });
    expect(prepared.plan.conflicts).toEqual([
      expect.objectContaining({ kind: 'content-changed', path: 'note.txt' }),
    ]);
    const refused = await engine.applyCombinedRecovery({
      confirmedConflicts: [],
      conflictPolicy: 'abort', expectedRevision: prepared.plan.revision, operationId: prepared.plan.id,
    });
    expect(refused).toMatchObject({ status: 'failed', failure: { code: 'path-conflict' } });
    expect(await fs.promises.readFile(target, 'utf8')).toBe('user-later');

    const forced = await applyCombined(engine, {
      confirmedConflicts: prepared.plan.conflicts.map((conflict) => ({
        fingerprint: conflict.fingerprint,
        path: conflict.path,
      })),
      conflictPolicy: 'overwrite-confirmed',
      expectedRevision: prepared.plan.revision,
      operationId: prepared.plan.id,
    });
    expect(forced.operation.state).toBe('complete');
    expect(await fs.promises.readFile(target, 'utf8')).toBe('before');
  });

  it('surfaces an unsaved editor buffer only for the affected path', async () => {
    const { engine, harness } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);
    await harness.authority.publishDirtyBuffers({
      generation: 1,
      ownerId: 'surface-1',
      resources: [{
        baseRevision: null,
        localEditRevision: 1,
        resource: { resourceId: 'note.txt', workspaceId: harness.identity.workspaceId },
      }],
      workspaceId: harness.identity.workspaceId,
    });

    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
    });
    expect(prepared.plan.conflicts).toEqual([
      expect.objectContaining({ kind: 'dirty-buffer', path: 'note.txt' }),
    ]);
  });

  it('does not claim exact file recovery for unjournaled shell changes', async () => {
    const { engine, harness } = await createHarness();
    await fs.promises.writeFile(path.join(harness.workspaceRoot, 'shell.txt'), 'changed by shell');
    await startTurn(engine, harness);
    await settleTurn(engine, harness, {
      mutationObserved: true,
      observationComplete: true,
      observedResourceIds: ['shell.txt'],
    });
    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
    });
    expect(prepared.plan.coverage).toBe('none');
    expect(prepared.plan.uncoveredPaths).toEqual([
      { path: 'shell.txt', source: 'external' },
    ]);
    expect(prepared.plan.affectedPaths).toEqual([]);
    const applied = await engine.applyCombinedRecovery({
      confirmedConflicts: [],
      conflictPolicy: 'abort', expectedRevision: prepared.plan.revision, operationId: prepared.plan.id,
    });
    expect(applied).toMatchObject({ status: 'failed', failure: { code: 'checkpoint-incomplete' } });
  });

  it('reports partial coverage when a journaled write coexists with an unjournaled shell change', async () => {
    const { engine, harness } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    const shellTarget = path.join(harness.workspaceRoot, 'shell.txt');
    await fs.promises.writeFile(target, 'before');
    await fs.promises.writeFile(shellTarget, 'shell-before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    // Simulate a shell change that the watcher observes but the journal never captures.
    await fs.promises.writeFile(shellTarget, 'changed by shell');
    await settleTurn(engine, harness, {
      mutationObserved: true,
      observationComplete: true,
      observedResourceIds: ['note.txt', 'shell.txt'],
    });
    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
    });
    expect(prepared.plan.coverage).toBe('partial');
    expect(prepared.plan.affectedPaths).toEqual(['note.txt']);
    expect(prepared.plan.uncoveredPaths).toEqual([
      { path: 'shell.txt', source: 'external' },
    ]);
    // Apply should succeed — the journaled path is restorable, the shell path is left as-is.
    const applied = await applyCombined(engine, {
      confirmedConflicts: [],
      conflictPolicy: 'abort', expectedRevision: prepared.plan.revision, operationId: prepared.plan.id,
    });
    expect(applied).toMatchObject({
      status: 'ready',
      operation: { conversationState: 'navigated', fileState: 'restored', state: 'complete' },
    });
    expect(await fs.promises.readFile(target, 'utf8')).toBe('before');
    // The shell path was not restored — it keeps the unjournaled change.
    expect(await fs.promises.readFile(shellTarget, 'utf8')).toBe('changed by shell');
  });

  it('stores affected-path safety state and can undo a completed combined rollback', async () => {
    const { engine, harness, navigation } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);
    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
    });
    const applied = await applyCombined(engine, {
      confirmedConflicts: [],
      conflictPolicy: 'abort', expectedRevision: prepared.plan.revision, operationId: prepared.plan.id,
    });
    const undo = ready(await engine.prepareCombinedUndo(applied.operation.id));
    const redone = await applyCombined(engine, {
      confirmedConflicts: [],
      conflictPolicy: 'abort', expectedRevision: undo.plan.revision, operationId: undo.plan.id,
    });
    expect(redone.operation).toMatchObject({ state: 'complete', undoOf: applied.operation.id });
    expect(await fs.promises.readFile(target, 'utf8')).toBe('after');
    expect(navigation.commitLeaf).toHaveBeenCalledOnce();
  });

  it('keeps newly referenced objects reachable during cleanup', async () => {
    const { engine, harness } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);

    const cleaned = await engine.cleanupStorage({ workspaceId: harness.identity.workspaceId });
    expect(cleaned).toMatchObject({
      status: 'ready',
      result: { objectsDeleted: 0, recordsDeleted: 0, status: 'complete' },
    });
    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
    });
    const applied = await applyCombined(engine, {
      confirmedConflicts: [],
      conflictPolicy: 'abort',
      expectedRevision: prepared.plan.revision,
      operationId: prepared.plan.id,
    });
    expect(applied).toMatchObject({ status: 'ready', operation: { state: 'complete' } });
    expect(await fs.promises.readFile(target, 'utf8')).toBe('before');
  });

  it('compensates only the affected paths when Pi rejects conversation navigation', async () => {
    const navigation: RecoverySessionNavigation = {
      commit: vi.fn(async () => { throw new Error('leaf changed'); }),
      commitLeaf: vi.fn(async () => ({ markerId: 'unused' })),
      prepare: vi.fn(async (input) => ({
        expectedLeafId: 'leaf-current',
        removedEntryIds: [input.entryId, 'assistant-1'],
        targetLeafId: 'leaf-before',
      })),
      prepareLeaf: vi.fn(async (input) => ({
        expectedLeafId: 'leaf-before',
        removedEntryIds: [],
        targetLeafId: input.targetLeafId,
      })),
    };
    const { engine, harness } = await createHarness({ sessionNavigation: navigation });
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);
    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
    });
    const result = await engine.applyCombinedRecovery({
      confirmedConflicts: [],
      conflictPolicy: 'abort', expectedRevision: prepared.plan.revision, operationId: prepared.plan.id,
    });
    expect(result).toMatchObject({ status: 'failed', failure: { code: 'navigation-conflict' } });
    expect(await fs.promises.readFile(target, 'utf8')).toBe('after');
    expect(await engine.getCombinedOperation(prepared.plan.id)).toMatchObject({
      status: 'ready',
      operation: { conversationState: 'diverged', fileState: 'compensated', state: 'compensated' },
    });
  });

  it('keeps application-data history cleanable while the workspace is offline', async () => {
    const { engine, harness } = await createHarness();
    await engine.createCheckpoint({
      name: 'Offline marker',
      workspaceId: harness.identity.workspaceId,
    });
    const offline = `${harness.workspaceRoot}-offline`;
    await fs.promises.rename(harness.workspaceRoot, offline);
    try {
      expect(await engine.listStorageWorkspaces()).toMatchObject({
        status: 'ready',
        workspaces: [expect.objectContaining({
          checkpointCount: 1,
          storageAvailable: true,
          workspaceAvailable: false,
        })],
      });
      expect(await engine.cleanupStorage({ workspaceId: harness.identity.workspaceId }))
        .toMatchObject({ status: 'ready', result: { status: 'complete' } });
    } finally {
      await fs.promises.rename(offline, harness.workspaceRoot);
    }
  });

  it('keeps the old storage authority when a verified location transfer fails', async () => {
    const harness = await createDocumentAuthorityHarness();
    harnesses.add(harness);
    const fsPromises = Object.create(fs.promises);
    fsPromises.cp = vi.fn(async () => {
      throw Object.assign(new Error('copy failed'), { code: 'EIO' });
    });
    const engine = createWorkspaceRecoveryEngine({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      documents: harness.authority,
      fsPromises,
      sessionNavigation: createTestNavigation(),
    });
    await engine.createCheckpoint({ name: 'Retained', workspaceId: harness.identity.workspaceId });
    const moved = await engine.setStorageLocation({
      location: { mode: 'workspace-adjacent' },
      workspaceId: harness.identity.workspaceId,
    });
    expect(moved).toMatchObject({ status: 'ready', operation: { state: 'failed' } });
    expect(await engine.status(harness.identity.workspaceId)).toMatchObject({
      status: 'ready',
      storage: { checkpointCount: 1, location: { mode: 'application-data' } },
    });
  });

  it('reports v5 recovery lifecycle capabilities as implemented', async () => {
    const { engine, harness } = await createHarness();
    const status = await engine.status(harness.identity.workspaceId);
    expect(status).toMatchObject({
      status: 'ready',
      capabilities: {
        bindings: true,
        catalogLifecycle: true,
        checkpoints: true,
        combined: true,
        conflictConfirmation: true,
        dirtyStateBarrier: true,
        journal: true,
        redo: true,
        retention: true,
        storageManagement: true,
        workspaceLease: true,
      },
      failures: [],
    });
  });

  it('applies configurable retention while preserving named checkpoints', async () => {
    const { engine, harness } = await createHarness();
    await startTurn(engine, harness, '1');
    await settleTurn(engine, harness, {
      assistantEntryId: 'assistant-1',
      executionId: 'execution-1',
      mutationObserved: false,
      observationComplete: false,
      observedResourceIds: [],
    });
    await startTurn(engine, harness, '2');
    await settleTurn(engine, harness, {
      assistantEntryId: 'assistant-2',
      executionId: 'execution-2',
      mutationObserved: false,
      observationComplete: false,
      observedResourceIds: [],
    });
    await engine.createCheckpoint({ name: 'Keep this marker', workspaceId: harness.identity.workspaceId });

    const updated = await engine.setRetentionPolicy({
      policy: {
        maxAgeDays: null,
        maxByteLength: null,
        maxCheckpointCount: 1,
        maxOperationCount: null,
      },
      workspaceId: harness.identity.workspaceId,
    });
    expect(updated).toMatchObject({
      status: 'ready',
      retention: {
        eligibleCheckpointCount: 1,
        policy: { maxCheckpointCount: 1 },
        protectedCheckpointCount: 1,
      },
    });
    const listed = await listCheckpoints(engine, { workspaceId: harness.identity.workspaceId });
    expect(listed.page.checkpoints.map((checkpoint) => checkpoint.source).sort())
      .toEqual(['named', 'turn']);
    expect(listed.page.checkpoints.find((checkpoint) => checkpoint.source === 'named')?.label)
      .toBe('Keep this marker');
  });

  it('runs configured retention after a turn settles', async () => {
    const { engine, harness } = await createHarness();
    await engine.setRetentionPolicy({
      policy: {
        maxAgeDays: null,
        maxByteLength: null,
        maxCheckpointCount: 1,
        maxOperationCount: null,
      },
      workspaceId: harness.identity.workspaceId,
    });
    for (const suffix of ['1', '2']) {
      await startTurn(engine, harness, suffix);
      await settleTurn(engine, harness, {
        assistantEntryId: `assistant-${suffix}`,
        executionId: `execution-${suffix}`,
        mutationObserved: false,
        observationComplete: false,
        observedResourceIds: [],
      });
    }
    await vi.waitFor(async () => {
      const listed = await listCheckpoints(engine, { workspaceId: harness.identity.workspaceId });
      expect(listed.page.checkpoints).toHaveLength(1);
    });
    expect(await engine.retentionStatus(harness.identity.workspaceId)).toMatchObject({
      status: 'ready',
      retention: { eligibleCheckpointCount: 1, lastRunAt: expect.any(String) },
    });
  });

  it('rejects overwrite-confirmed when a conflict fingerprint changed after review', async () => {
    const { engine, harness } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);
    await fs.promises.writeFile(target, 'user-later-v1');

    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
    });
    expect(prepared.plan.conflicts).toHaveLength(1);
    // File changes again after conflict review — fingerprint must differ.
    await fs.promises.writeFile(target, 'user-later-v2');
    const stale = await engine.applyCombinedRecovery({
      confirmedConflicts: prepared.plan.conflicts.map((conflict) => ({
        fingerprint: conflict.fingerprint,
        path: conflict.path,
      })),
      conflictPolicy: 'overwrite-confirmed',
      expectedRevision: prepared.plan.revision,
      operationId: prepared.plan.id,
    });
    expect(stale).toMatchObject({ status: 'failed', failure: { code: 'stale-plan', retryable: true } });
    // The file must not have been overwritten.
    expect(await fs.promises.readFile(target, 'utf8')).toBe('user-later-v2');
  });

  it('rejects overwrite-confirmed for an acknowledged dirty-buffer conflict', async () => {
    const { engine, harness } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);
    await harness.authority.publishDirtyBuffers({
      generation: 1,
      ownerId: 'surface-1',
      resources: [{
        baseRevision: null,
        localEditRevision: 1,
        resource: { resourceId: 'note.txt', workspaceId: harness.identity.workspaceId },
      }],
      workspaceId: harness.identity.workspaceId,
    });

    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
    });
    expect(prepared.plan.conflicts[0]?.kind).toBe('dirty-buffer');
    const rejected = await engine.applyCombinedRecovery({
      confirmedConflicts: prepared.plan.conflicts.map((conflict) => ({
        fingerprint: conflict.fingerprint,
        path: conflict.path,
      })),
      conflictPolicy: 'overwrite-confirmed',
      expectedRevision: prepared.plan.revision,
      operationId: prepared.plan.id,
    });
    expect(rejected).toMatchObject({ status: 'failed', failure: { code: 'dirty-buffers' } });
  });

  it('deletes workspace history with scoped row deletion instead of removing the entire storage root', async () => {
    const { engine, harness } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);
    const checkpoint = ready(await engine.createCheckpoint({
      name: 'Pre-delete', workspaceId: harness.identity.workspaceId,
    }));
    expect(checkpoint.status).toBe('ready');
    expect(checkpoint.checkpoint.id).toBeTruthy();

    const deleted = await engine.deleteWorkspaceHistory(harness.identity.workspaceId);
    expect(deleted).toMatchObject({ status: 'ready', result: { status: 'complete' } });

    // The workspace's checkpoints should be gone from the catalog.
    const statusAfter = ready(await engine.storageStatus(harness.identity.workspaceId));
    expect(statusAfter.storage.checkpointCount).toBe(0);

    // The catalog must still be usable — creating a new checkpoint should
    // succeed, proving the storage root and catalog were not rm-rfed.
    const recreated = await engine.createCheckpoint({
      name: 'Post-delete', workspaceId: harness.identity.workspaceId,
    });
    expect(recreated).toMatchObject({ status: 'ready', checkpoint: { label: 'Post-delete' } });
  });

  it('deletes only one workspace history when one catalog contains another workspace', async () => {
    const { engine, harness } = await createHarness();
    const notePath = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(notePath, 'before-1');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after-1');
    await settleTurn(engine, harness);
    const checkpoint = await engine.createCheckpoint({
      name: 'WS1-checkpoint', workspaceId: harness.identity.workspaceId,
    });
    expect(checkpoint.status).toBe('ready');

    const { objectPath, openRecoveryJournalCatalog } = await import('./journal-catalog.js');
    const { createRecoveryLocationRegistry } = await import('./locations.js');
    const locations = createRecoveryLocationRegistry({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      defaultRecoveryDir: undefined,
      fsPromises: fs.promises,
      pathModule: path,
      storageOwnerId: 'piarium.builtin.recovery',
    });
    const selected = await locations.selection(harness.identity.workspaceId);
    const storageRoot = await locations.resolve(recoveryIdentity(harness), selected.location);
    const otherWorkspaceId = 'workspace-in-shared-catalog';
    const otherCheckpointId = 'checkpoint-in-shared-catalog';
    const otherObjectBytes = Buffer.from('preserve this other workspace object');
    const otherObjectHash = `sha256-${createHash('sha256').update(otherObjectBytes).digest('hex')}`;
    const otherObjectPath = objectPath(storageRoot, otherObjectHash);
    await fs.promises.mkdir(path.dirname(otherObjectPath), { recursive: true });
    await fs.promises.writeFile(otherObjectPath, otherObjectBytes);

    const database = requireDatabase(await openRecoveryJournalCatalog(
      storageRoot,
      { create: false, fsPromises: fs.promises },
    ));
    let deletedWorkspaceObjectHashes: string[] = [];
    try {
      const rows = database.prepare(`
        SELECT before_json, after_json FROM checkpoint_changes
        WHERE checkpoint_id IN (SELECT id FROM checkpoints WHERE workspace_id = ?)
      `).all(harness.identity.workspaceId) as { after_json: string | null; before_json: string }[];
      deletedWorkspaceObjectHashes = rows.flatMap((row) => (
        [row.before_json, row.after_json]
          .filter((raw): raw is string => Boolean(raw))
          .map(objectHashFromJson)
          .filter((value): value is string => Boolean(value))
      ));
      database.prepare(`
        INSERT INTO checkpoints(id, workspace_id, sequence, source, state, created_at)
        VALUES (?, ?, 1, 'named', 'ready', ?)
      `).run(otherCheckpointId, otherWorkspaceId, new Date().toISOString());
      const now = new Date().toISOString();
      database.prepare(`
        INSERT INTO checkpoint_changes(
          checkpoint_id, path, tool_name, mutation_id, before_json, after_json, created_at, updated_at
        ) VALUES (?, 'other.txt', 'write', 'other-mutation', ?, NULL, ?, ?)
      `).run(otherCheckpointId, JSON.stringify({
        byteLength: otherObjectBytes.length,
        kind: 'regular-file',
        objectHash: otherObjectHash,
      }), now, now);
    } finally {
      database.close();
    }

    const deleted = await engine.deleteWorkspaceHistory(harness.identity.workspaceId);
    expect(deleted).toMatchObject({ status: 'ready', result: { status: 'complete' } });

    const preserved = requireDatabase(await openRecoveryJournalCatalog(
      storageRoot,
      { create: false, fsPromises: fs.promises },
    ));
    try {
      const count = preserved.prepare('SELECT COUNT(*) AS count FROM checkpoints WHERE workspace_id = ?')
        .get(harness.identity.workspaceId) as { count: number };
      expect(count.count).toBe(0);
      expect(preserved.prepare('SELECT id FROM checkpoints WHERE workspace_id = ?').all(otherWorkspaceId))
        .toEqual([{ id: otherCheckpointId }]);
      expect(preserved.prepare('SELECT path FROM checkpoint_changes WHERE checkpoint_id = ?').all(otherCheckpointId))
        .toEqual([{ path: 'other.txt' }]);
    } finally {
      preserved.close();
    }
    expect(await fs.promises.readFile(otherObjectPath)).toEqual(otherObjectBytes);
    for (const objectHash of deletedWorkspaceObjectHashes) {
      await expect(fs.promises.lstat(objectPath(storageRoot, objectHash))).rejects.toMatchObject({ code: 'ENOENT' });
    }

    const recreated = await engine.createCheckpoint({
      name: 'WS1-post-delete', workspaceId: harness.identity.workspaceId,
    });
    expect(recreated).toMatchObject({ status: 'ready', checkpoint: { label: 'WS1-post-delete' } });
  });

  it('reconciles a crash in the apply-intent window by detecting the target was already written', async () => {
    const { engine, harness } = await createHarness();
    const notePath = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(notePath, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);

    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
    });

    // Recovery semantics: target = 'before' (rollback destination), safety = 'after' (current).
    // Use a spy fileStore that crashes after applyState writes the rollback target.
    const { createRecoveryFileStore } = await import('./journal-files.js');
    const realFileStore = createRecoveryFileStore({ fsModule: fs, fsPromises: fs.promises, pathModule: path });
    const crashApplyState = vi.fn(async (...args: Parameters<RecoveryFileStore['applyState']>) => {
      await realFileStore.applyState(...args);
      throw new Error('SIMULATED_CRASH_AFTER_APPLY');
    });
    const crashFileStore: RecoveryFileStore = {
      ...realFileStore,
      applyState: crashApplyState,
    };
    const crashEngine = createWorkspaceRecoveryEngine({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      documents: harness.authority,
      fileStore: crashFileStore,
      sessionNavigation: {
        commit: vi.fn(async () => ({ markerId: 'marker-1' })),
        commitLeaf: vi.fn(async () => ({ markerId: 'marker-undo' })),
        prepare: vi.fn(async () => ({
          editorText: 'draft',
          expectedLeafId: 'leaf-current',
          removedEntryIds: ['user-1', 'assistant-1'],
          targetLeafId: 'leaf-before',
        })),
        prepareLeaf: vi.fn(async () => ({
          expectedLeafId: 'leaf-before',
          removedEntryIds: [],
          targetLeafId: 'leaf-before',
        })),
      },
    });
    const crashed = await crashEngine.applyCombinedRecovery({
      confirmedConflicts: [],
      conflictPolicy: 'abort',
      expectedRevision: prepared.plan.revision,
      operationId: prepared.plan.id,
    });
    expect(crashed).toMatchObject({ status: 'failed', failure: { message: 'SIMULATED_CRASH_AFTER_APPLY' } });
    expect(crashApplyState).toHaveBeenCalledOnce();

    // applyState wrote the rollback target ('before') to disk before crashing.
    expect(await fs.promises.readFile(notePath, 'utf8')).toBe('before');

    // The operation_files phase should still be 'apply-intent' because the
    // crash happened before the phase update to target-observed.
    const { openRecoveryJournalCatalog } = await import('./journal-catalog.js');
    const { createRecoveryLocationRegistry } = await import('./locations.js');
    const locations = createRecoveryLocationRegistry({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      defaultRecoveryDir: undefined,
      fsPromises: fs.promises,
      pathModule: path,
      storageOwnerId: 'piarium.builtin.recovery',
    });
    const selected = await locations.selection(harness.identity.workspaceId);
    const storageRoot = await locations.resolve(recoveryIdentity(harness), selected.location);
    const db = requireDatabase(await openRecoveryJournalCatalog(
      storageRoot,
      { create: false, fsPromises: fs.promises },
    ));
    try {
      const rows = db.prepare('SELECT phase FROM operation_files WHERE operation_id = ?')
        .all(prepared.plan.id) as { phase: string }[];
      expect(rows).toHaveLength(1);
      expect(rows.every((row) => row.phase === 'apply-intent')).toBe(true);
    } finally {
      db.close();
    }

    // Now create a fresh engine (simulating a restart) and call resumeCombinedOperations.
    // It should reconcile: disk == target, phase == apply-intent → target-observed,
    // then compensate writes safety ('after') back to disk.
    const restartEngine = createWorkspaceRecoveryEngine({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      documents: harness.authority,
      sessionNavigation: {
        commit: vi.fn(async () => ({ markerId: 'marker-1' })),
        commitLeaf: vi.fn(async () => ({ markerId: 'marker-undo' })),
        prepare: vi.fn(async () => ({
          editorText: 'draft',
          expectedLeafId: 'leaf-current',
          removedEntryIds: ['user-1', 'assistant-1'],
          targetLeafId: 'leaf-before',
        })),
        prepareLeaf: vi.fn(async () => ({
          expectedLeafId: 'leaf-before',
          removedEntryIds: [],
          targetLeafId: 'leaf-before',
        })),
      },
    });
    await restartEngine.resumeCombinedOperations();

    // After resume, the file should be compensated back to safety ('after').
    expect(await fs.promises.readFile(notePath, 'utf8')).toBe('after');
  });

  it('reconciles a crash in the compensate-intent window by detecting safety was already written', async () => {
    const { engine, harness } = await createHarness();
    const notePath = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(notePath, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);

    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
    });

    // Recovery semantics: target = 'before', safety = 'after'.
    // Phase 1: applyState writes target ('before') — succeeds.
    // Phase 2: sessionNavigation.commit throws → triggers compensation.
    // Phase 3: compensation applyState writes safety ('after') — then crashes.
    // This leaves the operation in 'compensating-files' with phase 'compensate-intent'
    // and the file at safety ('after') on disk.
    const { createRecoveryFileStore } = await import('./journal-files.js');
    const realFileStore = createRecoveryFileStore({ fsModule: fs, fsPromises: fs.promises, pathModule: path });
    let applyCallCount = 0;
    const crashApplyState = vi.fn(async (...args: Parameters<RecoveryFileStore['applyState']>) => {
      applyCallCount += 1;
      await realFileStore.applyState(...args);
      if (applyCallCount === 2) {
        // Second call is the compensation write — crash after it.
        throw new Error('SIMULATED_CRASH_AFTER_COMPENSATE');
      }
    });
    const crashFileStore: RecoveryFileStore = {
      ...realFileStore,
      applyState: crashApplyState,
    };
    const crashEngine = createWorkspaceRecoveryEngine({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      documents: harness.authority,
      fileStore: crashFileStore,
      sessionNavigation: {
        commit: vi.fn(async () => { throw new Error('NAVIGATION_REJECTED'); }),
        commitLeaf: vi.fn(async () => ({ markerId: 'marker-undo' })),
        prepare: vi.fn(async () => ({
          editorText: 'draft',
          expectedLeafId: 'leaf-current',
          removedEntryIds: ['user-1', 'assistant-1'],
          targetLeafId: 'leaf-before',
        })),
        prepareLeaf: vi.fn(async () => ({
          expectedLeafId: 'leaf-before',
          removedEntryIds: [],
          targetLeafId: 'leaf-before',
        })),
      },
    });
    const crashed = await crashEngine.applyCombinedRecovery({
      confirmedConflicts: [],
      conflictPolicy: 'abort',
      expectedRevision: prepared.plan.revision,
      operationId: prepared.plan.id,
    });
    expect(crashed.status).toBe('failed');
    expect(crashApplyState).toHaveBeenCalledTimes(2);

    // After the crash: file is at safety ('after') because compensation wrote it.
    expect(await fs.promises.readFile(notePath, 'utf8')).toBe('after');

    // The operation_files phase should be 'compensate-intent' (crash before safety-observed).
    const { openRecoveryJournalCatalog } = await import('./journal-catalog.js');
    const { createRecoveryLocationRegistry } = await import('./locations.js');
    const locations = createRecoveryLocationRegistry({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      defaultRecoveryDir: undefined,
      fsPromises: fs.promises,
      pathModule: path,
      storageOwnerId: 'piarium.builtin.recovery',
    });
    const selected = await locations.selection(harness.identity.workspaceId);
    const storageRoot = await locations.resolve(recoveryIdentity(harness), selected.location);
    const db = requireDatabase(await openRecoveryJournalCatalog(
      storageRoot,
      { create: false, fsPromises: fs.promises },
    ));
    try {
      const rows = db.prepare('SELECT phase FROM operation_files WHERE operation_id = ?')
        .all(prepared.plan.id) as { phase: string }[];
      expect(rows.every((row) => row.phase === 'compensate-intent')).toBe(true);
    } finally {
      db.close();
    }

    // Restart: reconcile should detect disk == safety → phase = safety-observed.
    // Then resume should converge the operation to 'compensated'.
    const restartEngine = createWorkspaceRecoveryEngine({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      documents: harness.authority,
      sessionNavigation: {
        commit: vi.fn(async () => ({ markerId: 'marker-1' })),
        commitLeaf: vi.fn(async () => ({ markerId: 'marker-undo' })),
        prepare: vi.fn(async () => ({
          editorText: 'draft',
          expectedLeafId: 'leaf-current',
          removedEntryIds: ['user-1', 'assistant-1'],
          targetLeafId: 'leaf-before',
        })),
        prepareLeaf: vi.fn(async () => ({
          expectedLeafId: 'leaf-before',
          removedEntryIds: [],
          targetLeafId: 'leaf-before',
        })),
      },
    });
    await restartEngine.resumeCombinedOperations();

    // File should remain at safety ('after') — reconciliation detected it.
    expect(await fs.promises.readFile(notePath, 'utf8')).toBe('after');

    // The operation should converge to 'compensated', not 'aborted'.
    expect(await restartEngine.getCombinedOperation(prepared.plan.id)).toMatchObject({
      status: 'ready',
      operation: { fileState: 'compensated', state: 'compensated' },
    });
  });

  it('blocks retry when a file is in needs-attention state', async () => {
    const { engine, harness } = await createHarness();
    const notePath = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(notePath, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);

    const prepared = await prepareCombined(engine, {
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
    });

    // Use a crash fileStore to capture safety and crash during applyState.
    const { createRecoveryFileStore } = await import('./journal-files.js');
    const realFileStore = createRecoveryFileStore({ fsModule: fs, fsPromises: fs.promises, pathModule: path });
    const crashApplyState = vi.fn(async (...args: Parameters<RecoveryFileStore['applyState']>) => {
      await realFileStore.applyState(...args);
      throw new Error('SIMULATED_CRASH_AFTER_APPLY');
    });
    const crashFileStore: RecoveryFileStore = {
      ...realFileStore,
      applyState: crashApplyState,
    };
    const crashEngine = createWorkspaceRecoveryEngine({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      documents: harness.authority,
      fileStore: crashFileStore,
      sessionNavigation: {
        commit: vi.fn(async () => ({ markerId: 'marker-1' })),
        commitLeaf: vi.fn(async () => ({ markerId: 'marker-undo' })),
        prepare: vi.fn(async () => ({
          editorText: 'draft',
          expectedLeafId: 'leaf-current',
          removedEntryIds: ['user-1', 'assistant-1'],
          targetLeafId: 'leaf-before',
        })),
        prepareLeaf: vi.fn(async () => ({
          expectedLeafId: 'leaf-before',
          removedEntryIds: [],
          targetLeafId: 'leaf-before',
        })),
      },
    });
    const crashed = await crashEngine.applyCombinedRecovery({
      confirmedConflicts: [],
      conflictPolicy: 'abort',
      expectedRevision: prepared.plan.revision,
      operationId: prepared.plan.id,
    });
    expect(crashed.status).toBe('failed');

    // Now manually set the file to needs-attention in the DB.
    const { openRecoveryJournalCatalog, updateOperationFilePhase } = await import('./journal-catalog.js');
    const { createRecoveryLocationRegistry } = await import('./locations.js');
    const locations = createRecoveryLocationRegistry({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      defaultRecoveryDir: undefined,
      fsPromises: fs.promises,
      pathModule: path,
      storageOwnerId: 'piarium.builtin.recovery',
    });
    const selected = await locations.selection(harness.identity.workspaceId);
    const storageRoot = await locations.resolve(recoveryIdentity(harness), selected.location);
    const db = requireDatabase(await openRecoveryJournalCatalog(
      storageRoot,
      { create: false, fsPromises: fs.promises },
    ));
    try {
      updateOperationFilePhase(db, prepared.plan.id, 'note.txt', 'needs-attention');
    } finally {
      db.close();
    }

    // Reset the file to safety state ('after').
    await fs.promises.writeFile(notePath, 'after');

    // Attempt to retry with the original engine — should fail because
    // needs-attention is a blocking terminal phase.
    const result = await engine.applyCombinedRecovery({
      confirmedConflicts: [],
      conflictPolicy: 'abort',
      expectedRevision: prepared.plan.revision,
      operationId: prepared.plan.id,
    });
    expect(result).toMatchObject({ status: 'failed', failure: { code: 'needs-attention' } });
    expect(await engine.getCombinedOperation(prepared.plan.id)).toMatchObject({
      status: 'ready',
      operation: {
        failure: { code: 'needs-attention' },
        fileState: 'needs-attention',
        state: 'needs-attention',
      },
    });
    // The file must not have been changed.
    expect(await fs.promises.readFile(notePath, 'utf8')).toBe('after');
  });
});
