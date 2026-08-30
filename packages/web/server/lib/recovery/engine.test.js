import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import { createWorkspaceRecoveryEngine } from './engine.js';

const harnesses = new Set();

const createHarness = async (options = {}) => {
  const harness = await createDocumentAuthorityHarness();
  harnesses.add(harness);
  const navigation = options.sessionNavigation ?? {
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
  };
  const engine = createWorkspaceRecoveryEngine({
    authorityId: harness.authority.hostId,
    dataDir: harness.dataDir,
    documents: harness.authority,
    sessionNavigation: navigation,
    ...options,
  });
  return { engine, harness, navigation };
};

const startTurn = (engine, harness, suffix = '1') => engine.recordTurnStart({
  activeWriterScopes: [],
  executionId: `execution-${suffix}`,
  provenance: 'caused-by',
  runtimeGeneration: 1,
  sessionId: 'session-1',
  userEntryId: `user-${suffix}`,
  workerId: 'worker-1',
  workspaceId: harness.identity.workspaceId,
});

const settleTurn = (engine, harness, options = {}) => engine.recordTurnSettled({
  activeWriterScopes: [],
  assistantEntryId: options.assistantEntryId ?? 'assistant-1',
  executionId: options.executionId ?? 'execution-1',
  mutationObserved: options.mutationObserved ?? true,
  observationComplete: options.observationComplete ?? true,
  observedResourceIds: options.observedResourceIds ?? ['note.txt'],
  provenance: 'caused-by',
  workspaceId: harness.identity.workspaceId,
});

const recordWrite = async (engine, harness, content) => {
  const target = path.join(harness.workspaceRoot, 'note.txt');
  const base = {
    executionId: 'execution-1',
    mutationId: 'mutation-1',
    path: target,
    toolCallId: 'tool-1',
    toolName: 'write',
    workspaceId: harness.identity.workspaceId,
  };
  expect(await engine.recordMutationBefore(base)).toMatchObject({ recorded: true, status: 'ready' });
  await fs.promises.writeFile(target, content);
  expect(await engine.recordMutationAfter({ ...base, succeeded: true }))
    .toMatchObject({ recorded: true, status: 'ready' });
};

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
    const listed = await engine.listCheckpoints({ workspaceId: harness.identity.workspaceId });
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

    const prepared = await engine.prepareCombinedRecovery({
      entryId: 'user-1',
      sessionId: 'session-1',
      workspaceId: harness.identity.workspaceId,
    });
    expect(prepared).toMatchObject({
      status: 'ready',
      plan: { affectedPaths: ['note.txt'], conflicts: [], coverage: 'ready' },
    });
    const applied = await engine.applyCombinedRecovery({
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

  it('keeps the first before-image and last after-image across repeated writes in one turn', async () => {
    const { engine, harness } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'original');
    await startTurn(engine, harness);
    const base = {
      executionId: 'execution-1',
      path: target,
      toolCallId: 'tool-1',
      toolName: 'edit',
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

    const prepared = await engine.prepareCombinedRecovery({
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
    });
    await engine.applyCombinedRecovery({
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
    const prepared = await engine.prepareCombinedRecovery({
      entryId: 'user-1',
      sessionId: 'session-1',
      workspaceId: harness.identity.workspaceId,
    });
    expect(prepared.plan).toMatchObject({ affectedPaths: [], changedBytes: 0, coverage: 'ready' });
    const applied = await engine.applyCombinedRecovery({
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
      toolCallId: 'tool-same', toolName: 'write', workspaceId: harness.identity.workspaceId,
    };
    expect(await engine.recordMutationBefore(mutation)).toMatchObject({ recorded: true });
    await fs.promises.writeFile(target, 'same');
    expect(await engine.recordMutationAfter({ ...mutation, succeeded: true }))
      .toMatchObject({ recorded: false });
    await settleTurn(engine, harness);
    const prepared = await engine.prepareCombinedRecovery({
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
    });
    expect(prepared.plan).toMatchObject({ affectedPaths: [], coverage: 'ready' });
  });

  it('detects later user edits per path and overwrites only after an explicit choice', async () => {
    const { engine, harness } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'agent');
    await settleTurn(engine, harness);
    await fs.promises.writeFile(target, 'user-later');

    const prepared = await engine.prepareCombinedRecovery({
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
    });
    expect(prepared.plan.conflicts).toEqual([
      expect.objectContaining({ kind: 'content-changed', path: 'note.txt' }),
    ]);
    const refused = await engine.applyCombinedRecovery({
      conflictPolicy: 'abort', expectedRevision: prepared.plan.revision, operationId: prepared.plan.id,
    });
    expect(refused).toMatchObject({ status: 'failed', failure: { code: 'path-conflict' } });
    expect(await fs.promises.readFile(target, 'utf8')).toBe('user-later');

    const forced = await engine.applyCombinedRecovery({
      conflictPolicy: 'overwrite', expectedRevision: prepared.plan.revision, operationId: prepared.plan.id,
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

    const prepared = await engine.prepareCombinedRecovery({
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
    const prepared = await engine.prepareCombinedRecovery({
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
    });
    expect(prepared.plan.coverage).toBe('incomplete');
    const applied = await engine.applyCombinedRecovery({
      conflictPolicy: 'abort', expectedRevision: prepared.plan.revision, operationId: prepared.plan.id,
    });
    expect(applied).toMatchObject({ status: 'failed', failure: { code: 'checkpoint-incomplete' } });
  });

  it('stores affected-path safety state and can undo a completed combined rollback', async () => {
    const { engine, harness, navigation } = await createHarness();
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);
    const prepared = await engine.prepareCombinedRecovery({
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
    });
    const applied = await engine.applyCombinedRecovery({
      conflictPolicy: 'abort', expectedRevision: prepared.plan.revision, operationId: prepared.plan.id,
    });
    const undo = await engine.prepareCombinedUndo(applied.operation.id);
    const redone = await engine.applyCombinedRecovery({
      conflictPolicy: 'abort', expectedRevision: undo.plan.revision, operationId: undo.plan.id,
    });
    expect(redone.operation).toMatchObject({ state: 'complete', undoOf: applied.operation.id });
    expect(await fs.promises.readFile(target, 'utf8')).toBe('after');
    expect(navigation.commitLeaf).toHaveBeenCalledOnce();
  });

  it('compensates only the affected paths when Pi rejects conversation navigation', async () => {
    const navigation = {
      commit: vi.fn(async () => { throw new Error('leaf changed'); }),
      commitLeaf: vi.fn(),
      prepare: vi.fn(async (input) => ({
        expectedLeafId: 'leaf-current',
        removedEntryIds: [input.entryId, 'assistant-1'],
        targetLeafId: 'leaf-before',
      })),
      prepareLeaf: vi.fn(),
    };
    const { engine, harness } = await createHarness({ sessionNavigation: navigation });
    const target = path.join(harness.workspaceRoot, 'note.txt');
    await fs.promises.writeFile(target, 'before');
    await startTurn(engine, harness);
    await recordWrite(engine, harness, 'after');
    await settleTurn(engine, harness);
    const prepared = await engine.prepareCombinedRecovery({
      entryId: 'user-1', sessionId: 'session-1', workspaceId: harness.identity.workspaceId,
    });
    const result = await engine.applyCombinedRecovery({
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
      sessionNavigation: {},
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
});
