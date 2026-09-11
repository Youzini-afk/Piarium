import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachLiveSurfaceCompleter,
  createDocumentAuthorityHarness,
  hashSurfaceText,
  type DocumentAuthorityHarness,
  type LiveSurfaceBuffer,
} from './contract-fixtures.js';
import {
  beginAgentMutationOperation,
  inspectAgentMutationOperation,
  markAgentMutationPathApplied,
  markAgentMutationSurfaceDispatched,
  reconcileInterruptedAgentMutations,
} from './agent-mutation-operation.js';
import { openRecoveryJournalCatalog } from '../recovery/journal-catalog.js';
import { createRecoveryFileStore } from '../recovery/journal-files.js';
import type { DurableFileOperationContext } from '../recovery/durable-file-operation.js';

const utf16LeHello = Buffer.from([
  0xff, 0xfe, 0x68, 0x00, 0x69, 0x00,
]);

const bindDurableCatalog = async (harness: DocumentAuthorityHarness) => {
  const recoveryRoot = path.join(harness.dataDir, 'agent-mutation-catalog');
  await fs.promises.mkdir(recoveryRoot, { recursive: true });
  const fileStore = createRecoveryFileStore();
  const inspected = await harness.authority.inspectWorkspace(harness.identity.workspaceId);
  const identity = {
    authorityId: harness.authority.hostId,
    canonicalRoot: inspected.root,
    filesystemProfile: 'test',
    workspaceId: harness.identity.workspaceId,
  };
  harness.authority.bindDurableMutationStorage(async (_workspaceId, operation) => {
    const database = await openRecoveryJournalCatalog(recoveryRoot, { create: true });
    try {
      return await operation({
        database,
        fileStore,
        identity,
        resourceOperationGate: {
          run: (resources, next) => harness.authority.runResourceOperation(
            harness.identity.workspaceId,
            resources,
            next,
          ),
        },
        root: recoveryRoot,
      });
    } finally {
      database.close();
    }
  });
  return { recoveryRoot, identity, fileStore };
};

const reopenCatalog = async (recoveryRoot: string) => {
  const database = await openRecoveryJournalCatalog(recoveryRoot, { create: false });
  if (!database) throw new Error('expected reopened recovery catalog');
  return database;
};

describe('surface identity and durable compensation', () => {
  let harness: DocumentAuthorityHarness | undefined;

  afterEach(async () => {
    if (!harness) return;
    const current = harness;
    harness = undefined;
    await current.cleanup();
  });

  it('keeps CRLF disk bytes while editing the normalized dirty buffer twice and via apply_patch write', async () => {
    harness = await createDocumentAuthorityHarness();
    const live = new Map<string, LiveSurfaceBuffer>();
    const surface = attachLiveSurfaceCompleter(harness.authority, {
      generation: 1,
      live,
      ownerId: 'surface-owner',
      workspaceId: harness.identity.workspaceId,
    });
    try {
      const diskBytes = Buffer.from('A\r\n', 'utf8');
      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'draft.ts'), diskBytes);
      const disk = await harness.authority.read(harness.resource('draft.ts'));
      if (disk.status !== 'ready') throw new Error('Expected CRLF fixture');
      const binding = {
        baseRevision: disk.revision,
        localEditRevision: 2,
        documentInstanceId: 'document-instance',
        bufferHash: hashSurfaceText('B\n'),
        encoding: 'utf-8' as const,
        bom: false,
        lineEnding: 'crlf' as const,
        resource: harness.resource('draft.ts'),
      };
      live.set('draft.ts', { ...binding, content: 'B\n' });
      await harness.authority.publishDirtyBuffers({
        generation: 1,
        ownerId: 'surface-owner',
        resources: [binding],
        workspaceId: harness.identity.workspaceId,
      });
      const context = await harness.authority.captureAgentInputSnapshot({
        generation: 1,
        ownerId: 'surface-owner',
        sessionId: 'session-crlf',
        workspaceId: harness.identity.workspaceId,
        resources: [{ ...binding, content: 'B\r\n' }],
      });
      harness.authority.commitAgentInputSnapshot('session-crlf', context);

      const first = await harness.authority.applyAgentSurfaceWrite('session-crlf', context, [{
        resourceId: 'draft.ts',
        action: 'edit',
        edits: [{ oldText: 'B\n', newText: 'C\n' }],
      }]);
      expect(first.status).toBe('applied');
      expect(live.get('draft.ts')?.content).toBe('C\n');
      expect(await fs.promises.readFile(path.join(harness.workspaceRoot, 'draft.ts'))).toEqual(diskBytes);
      expect(harness.authority.readAgentInputSnapshot('session-crlf', context, 'draft.ts')).toMatchObject({
        status: 'ready',
        content: 'C\r\n',
        source: 'surface-draft',
      });
      expect(harness.authority.inspectAgentInputSnapshot('session-crlf', context, 'draft.ts')).toMatchObject({
        status: 'ready',
        content: 'C\r\n',
        bufferHash: hashSurfaceText('C\n'),
        lineEnding: 'crlf',
      });

      const second = await harness.authority.applyAgentSurfaceWrite('session-crlf', context, [{
        resourceId: 'draft.ts',
        action: 'edit',
        edits: [{ oldText: 'C\n', newText: 'E\n' }],
      }]);
      expect(second.status).toBe('applied');
      expect(live.get('draft.ts')?.content).toBe('E\n');
      expect(harness.authority.readAgentInputSnapshot('session-crlf', context, 'draft.ts')).toMatchObject({
        status: 'ready',
        content: 'E\r\n',
      });
      expect(await fs.promises.readFile(path.join(harness.workspaceRoot, 'draft.ts'))).toEqual(diskBytes);

      const afterSecond = harness.authority.inspectAgentInputSnapshot('session-crlf', context, 'draft.ts');
      if (afterSecond.status !== 'ready') throw new Error('Expected CRLF snapshot after the second edit');
      const patched = await harness.authority.applyAgentSurfaceWrite('session-crlf', context, [{
        resourceId: 'draft.ts',
        action: 'write',
        content: 'P\n',
        expectedRevision: afterSecond.revision,
        expectedHash: hashSurfaceText('E\n'),
      }]);
      expect(patched.status).toBe('applied');
      expect(live.get('draft.ts')?.content).toBe('P\n');
      expect(harness.authority.readAgentInputSnapshot('session-crlf', context, 'draft.ts')).toMatchObject({
        status: 'ready',
        content: 'P\r\n',
      });
      expect(await fs.promises.readFile(path.join(harness.workspaceRoot, 'draft.ts'))).toEqual(diskBytes);
    } finally {
      surface.close();
    }
  });

  it('restores two surface paths with one Registry undo group after a later disk failure', async () => {
    harness = await createDocumentAuthorityHarness();
    const live = new Map<string, LiveSurfaceBuffer>();
    const surface = attachLiveSurfaceCompleter(harness.authority, {
      generation: 1,
      live,
      ownerId: 'surface-owner',
      workspaceId: harness.identity.workspaceId,
    });
    try {
      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'a.ts'), 'disk-a\n');
      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'b.ts'), 'disk-b\n');
      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'blocked.bin'), Buffer.from([0x00, 0x01, 0x02]));
      const diskA = await harness.authority.read(harness.resource('a.ts'));
      const diskB = await harness.authority.read(harness.resource('b.ts'));
      if (diskA.status !== 'ready' || diskB.status !== 'ready') throw new Error('Expected text fixtures');
      const bindingA = {
        baseRevision: diskA.revision,
        localEditRevision: 2,
        documentInstanceId: 'doc-a',
        bufferHash: hashSurfaceText('A\n'),
        encoding: 'utf-8' as const,
        bom: false,
        lineEnding: 'lf' as const,
        resource: harness.resource('a.ts'),
      };
      const bindingB = {
        baseRevision: diskB.revision,
        localEditRevision: 2,
        documentInstanceId: 'doc-b',
        bufferHash: hashSurfaceText('B\n'),
        encoding: 'utf-8' as const,
        bom: false,
        lineEnding: 'lf' as const,
        resource: harness.resource('b.ts'),
      };
      live.set('a.ts', { ...bindingA, content: 'A\n' });
      live.set('b.ts', { ...bindingB, content: 'B\n' });
      await harness.authority.publishDirtyBuffers({
        generation: 1,
        ownerId: 'surface-owner',
        resources: [bindingA, bindingB],
        workspaceId: harness.identity.workspaceId,
      });
      const context = await harness.authority.captureAgentInputSnapshot({
        generation: 1,
        ownerId: 'surface-owner',
        sessionId: 'session-group',
        workspaceId: harness.identity.workspaceId,
        resources: [
          { ...bindingA, content: 'A\n' },
          { ...bindingB, content: 'B\n' },
        ],
      });
      harness.authority.commitAgentInputSnapshot('session-group', context);

      const result = await harness.authority.applyAgentSurfaceWrite('session-group', context, [
        { resourceId: 'a.ts', action: 'edit', edits: [{ oldText: 'A\n', newText: 'C\n' }] },
        { resourceId: 'b.ts', action: 'edit', edits: [{ oldText: 'B\n', newText: 'D\n' }] },
        { resourceId: 'blocked.bin', action: 'write', content: 'nope\n' },
      ]);
      expect(result.status).toBe('conflict');
      if (result.status === 'disk') throw new Error('expected mixed results');
      expect(result.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'a.ts', target: 'surface', status: 'compensated' }),
        expect.objectContaining({ path: 'b.ts', target: 'surface', status: 'compensated' }),
        expect.objectContaining({ path: 'blocked.bin', target: 'disk', status: 'unavailable' }),
      ]));
      expect(live.get('a.ts')?.content).toBe('A\n');
      expect(live.get('b.ts')?.content).toBe('B\n');
      expect(await fs.promises.readFile(path.join(harness.workspaceRoot, 'a.ts'), 'utf8')).toBe('disk-a\n');
      expect(await fs.promises.readFile(path.join(harness.workspaceRoot, 'b.ts'), 'utf8')).toBe('disk-b\n');

      const publication = (await harness.authority.inspectDirtyBuffers(harness.identity.workspaceId))[0]!;
      const secondUndo = await harness.authority.requestSurfaceOperation({
        action: 'undo',
        generation: 1,
        operationId: result.operationId!,
        ownerId: 'surface-owner',
        registrationId: publication.registrationId!,
        workspaceId: harness.identity.workspaceId,
        targets: [{
          ...bindingA,
          expectedAppliedRevision: live.get('a.ts')!.localEditRevision,
          expectedAppliedHash: live.get('a.ts')!.bufferHash,
        }],
      });
      expect(secondUndo[0]?.status).toBe('failed');
      expect(live.get('a.ts')?.content).toBe('A\n');
      expect(live.get('b.ts')?.content).toBe('B\n');
    } finally {
      surface.close();
    }
  });

  it('restores UTF-16 BOM disk bytes after a later mixed-batch failure', async () => {
    harness = await createDocumentAuthorityHarness();
    const { recoveryRoot } = await bindDurableCatalog(harness);
    const live = new Map<string, LiveSurfaceBuffer>();
    const surface = attachLiveSurfaceCompleter(harness.authority, {
      generation: 1,
      live,
      ownerId: 'surface-owner',
      workspaceId: harness.identity.workspaceId,
    });
    try {
      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'draft.ts'), 'A\n');
      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'wide.txt'), utf16LeHello);
      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'blocked.bin'), Buffer.from([0x00, 0x01]));
      const disk = await harness.authority.read(harness.resource('draft.ts'));
      const wide = await harness.authority.read(harness.resource('wide.txt'));
      expect(wide.status).toBe('unsupported-encoding');
      if (disk.status !== 'ready') throw new Error('Expected draft fixture');
      const binding = {
        baseRevision: disk.revision,
        localEditRevision: 2,
        documentInstanceId: 'document-instance',
        bufferHash: hashSurfaceText('B\n'),
        encoding: 'utf-8' as const,
        bom: false,
        lineEnding: 'lf' as const,
        resource: harness.resource('draft.ts'),
      };
      live.set('draft.ts', { ...binding, content: 'B\n' });
      await harness.authority.publishDirtyBuffers({
        generation: 1,
        ownerId: 'surface-owner',
        resources: [binding],
        workspaceId: harness.identity.workspaceId,
      });
      const context = await harness.authority.captureAgentInputSnapshot({
        generation: 1,
        ownerId: 'surface-owner',
        sessionId: 'session-utf16',
        workspaceId: harness.identity.workspaceId,
        resources: [{ ...binding, content: 'B\n' }],
      });
      harness.authority.commitAgentInputSnapshot('session-utf16', context);

      const result = await harness.authority.applyAgentSurfaceWrite('session-utf16', context, [
        { resourceId: 'draft.ts', action: 'edit', edits: [{ oldText: 'B\n', newText: 'C\n' }] },
        { resourceId: 'wide.txt', action: 'write', content: 'overwritten\n' },
        { resourceId: 'blocked.bin', action: 'write', content: 'nope\n' },
      ]);
      expect(result.status).toBe('conflict');
      expect(live.get('draft.ts')?.content).toBe('B\n');
      expect(await fs.promises.readFile(path.join(harness.workspaceRoot, 'wide.txt'))).toEqual(utf16LeHello);
      expect(await fs.promises.readFile(path.join(harness.workspaceRoot, 'draft.ts'), 'utf8')).toBe('A\n');

      if (result.status === 'disk' || !result.operationId) throw new Error('expected persisted mixed mutation');
      const database = await reopenCatalog(recoveryRoot);
      try {
        const persisted = inspectAgentMutationOperation(database, result.operationId);
        expect(persisted?.data.diskIdentities['wide.txt']).toMatchObject({
          encoding: 'utf-16le',
          bom: true,
          existed: true,
        });
        expect(persisted?.state).toMatch(/compensated|needs-attention/);
      } finally {
        database.close();
      }
    } finally {
      surface.close();
    }
  });

  it('records compensated or needs-attention after a surface apply then I/O throw', async () => {
    const fsPromises = new Proxy(fs.promises, {
      get(target, property, receiver) {
        if (property === 'writeFile') {
          return async (...args: Parameters<typeof fs.promises.writeFile>) => {
            if (String(args[0]).includes('other.ts')) {
              throw new Error('injected disk I/O failure');
            }
            return target.writeFile(...args);
          };
        }
        const member = Reflect.get(target, property, receiver) as unknown;
        return typeof member === 'function' ? (member as (...inner: never[]) => unknown).bind(target) : member;
      },
    });
    harness = await createDocumentAuthorityHarness({ authority: { fsPromises } });
    const { recoveryRoot } = await bindDurableCatalog(harness);
    const live = new Map<string, LiveSurfaceBuffer>();
    const surface = attachLiveSurfaceCompleter(harness.authority, {
      generation: 1,
      live,
      ownerId: 'surface-owner',
      workspaceId: harness.identity.workspaceId,
    });
    try {
      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'draft.ts'), 'A\n');
      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'other.ts'), 'disk\n');
      const disk = await harness.authority.read(harness.resource('draft.ts'));
      if (disk.status !== 'ready') throw new Error('Expected draft fixture');
      const binding = {
        baseRevision: disk.revision,
        localEditRevision: 2,
        documentInstanceId: 'document-instance',
        bufferHash: hashSurfaceText('B\n'),
        encoding: 'utf-8' as const,
        bom: false,
        lineEnding: 'lf' as const,
        resource: harness.resource('draft.ts'),
      };
      live.set('draft.ts', { ...binding, content: 'B\n' });
      await harness.authority.publishDirtyBuffers({
        generation: 1,
        ownerId: 'surface-owner',
        resources: [binding],
        workspaceId: harness.identity.workspaceId,
      });
      const context = await harness.authority.captureAgentInputSnapshot({
        generation: 1,
        ownerId: 'surface-owner',
        sessionId: 'session-throw',
        workspaceId: harness.identity.workspaceId,
        resources: [{ ...binding, content: 'B\n' }],
      });
      harness.authority.commitAgentInputSnapshot('session-throw', context);

      const result = await harness.authority.applyAgentSurfaceWrite('session-throw', context, [
        { resourceId: 'draft.ts', action: 'edit', edits: [{ oldText: 'B\n', newText: 'C\n' }] },
        { resourceId: 'other.ts', action: 'write', content: 'new-disk\n' },
      ]);
      expect(result.status).toBe('conflict');
      expect(live.get('draft.ts')?.content).toBe('B\n');
      expect(await fs.promises.readFile(path.join(harness.workspaceRoot, 'other.ts'), 'utf8')).toBe('disk\n');
      if (result.status === 'disk' || !result.operationId) throw new Error('expected persisted mutation');

      const database = await reopenCatalog(recoveryRoot);
      try {
        const persisted = inspectAgentMutationOperation(database, result.operationId);
        expect(persisted).not.toBeNull();
        expect(persisted?.state).toMatch(/compensated|needs-attention/);
        expect(persisted?.data.intent).toBe('agent-surface-write');
      } finally {
        database.close();
      }
    } finally {
      surface.close();
    }
  });

  it('marks interrupted surface mutations needs-attention when the owner is gone', async () => {
    harness = await createDocumentAuthorityHarness();
    const recoveryRoot = path.join(harness.dataDir, 'reconcile-catalog');
    await fs.promises.mkdir(recoveryRoot, { recursive: true });
    const database = await openRecoveryJournalCatalog(recoveryRoot, { create: true });
    const context: DurableFileOperationContext = {
      database,
      fileStore: createRecoveryFileStore(),
      identity: {
        authorityId: harness.authority.hostId,
        canonicalRoot: (await harness.authority.inspectWorkspace(harness.identity.workspaceId)).root,
        filesystemProfile: 'test',
        workspaceId: harness.identity.workspaceId,
      },
      resourceOperationGate: { run: async (_resources, next) => next() },
      root: recoveryRoot,
    };
    const data = beginAgentMutationOperation(context, {
      operationId: 'op-surface-interrupt',
      sessionId: 'session-interrupt',
      workspaceId: harness.identity.workspaceId,
      targetKinds: { 'draft.ts': 'surface' },
      surfaceBindings: {
        'draft.ts': {
          ownerId: 'surface-owner',
          ownerGeneration: 1,
          ownerRegistrationId: 'reg-1',
          documentInstanceId: 'doc-1',
          baseRevision: 'disk-a',
          beforeLocalEditRevision: 2,
          beforeHash: hashSurfaceText('B\n'),
          encoding: 'utf-8',
          bom: false,
          lineEnding: 'lf',
        },
      },
      targets: { 'draft.ts': { expected: { kind: 'missing' }, target: { kind: 'missing' } } },
      safety: { 'draft.ts': { kind: 'missing' } },
    });
    markAgentMutationPathApplied(context, data, 'draft.ts', {
      afterLocalEditRevision: 3,
      afterHash: hashSurfaceText('C\n'),
    });
    database.close();

    const reopened = await reopenCatalog(recoveryRoot);
    try {
      const reopenedContext: DurableFileOperationContext = {
        ...context,
        database: reopened,
      };
      const outcome = await reconcileInterruptedAgentMutations(reopenedContext, {
        surfaceOwnerAvailable: () => false,
      });
      expect(outcome.needsAttention).toContain('op-surface-interrupt');
      expect(inspectAgentMutationOperation(reopened, 'op-surface-interrupt')?.state).toBe('needs-attention');
    } finally {
      reopened.close();
    }
  });

  it('keeps dispatched surface uncertainty while compensating another applied disk path', async () => {
    harness = await createDocumentAuthorityHarness();
    const activeHarness = harness;
    const { recoveryRoot, identity, fileStore } = await bindDurableCatalog(activeHarness);
    await fs.promises.writeFile(path.join(activeHarness.workspaceRoot, 'disk.txt'), 'before\n');
    const database = await openRecoveryJournalCatalog(recoveryRoot, { create: true });
    if (!database) throw new Error('expected recovery catalog');
    try {
      const safety = (await fileStore.captureState(identity, recoveryRoot, 'disk.txt', { store: true })).state;
      await fs.promises.writeFile(path.join(activeHarness.workspaceRoot, 'disk.txt'), 'after\n');
      const target = (await fileStore.captureState(identity, recoveryRoot, 'disk.txt', { store: true })).state;
      await fs.promises.writeFile(path.join(activeHarness.workspaceRoot, 'disk.txt'), 'after\n');
      const context: DurableFileOperationContext = {
        database,
        fileStore,
        identity,
        resourceOperationGate: {
          run: (resources, next) => activeHarness.authority.runResourceOperation(
            activeHarness.identity.workspaceId,
            resources,
            next,
          ),
        },
        root: recoveryRoot,
      };
      const data = beginAgentMutationOperation(context, {
        operationId: 'op-dispatched-surface',
        sessionId: 'session-dispatched',
        workspaceId: activeHarness.identity.workspaceId,
        targetKinds: { 'draft.ts': 'surface', 'disk.txt': 'disk' },
        surfaceBindings: {
          'draft.ts': {
            ownerId: 'surface-owner',
            ownerGeneration: 1,
            ownerRegistrationId: 'reg-1',
            documentInstanceId: 'doc-1',
            baseRevision: 'disk-a',
            beforeLocalEditRevision: 2,
            beforeHash: hashSurfaceText('before\n'),
            encoding: 'utf-8',
            bom: false,
            lineEnding: 'lf',
          },
        },
        targets: {
          'draft.ts': { expected: { kind: 'missing' }, target: { kind: 'missing' } },
          'disk.txt': { expected: safety, target },
        },
        safety: { 'draft.ts': { kind: 'missing' }, 'disk.txt': safety },
      });
      markAgentMutationSurfaceDispatched(context, data, 'draft.ts');
      markAgentMutationPathApplied(context, data, 'disk.txt', { target });
      const outcome = await reconcileInterruptedAgentMutations(context, {
        surfaceOwnerAvailable: () => true,
      });
      expect(outcome.needsAttention).toContain('op-dispatched-surface');
      expect(await fs.promises.readFile(path.join(activeHarness.workspaceRoot, 'disk.txt'), 'utf8')).toBe('before\n');
      const persisted = inspectAgentMutationOperation(database, 'op-dispatched-surface');
      expect(persisted?.state).toBe('needs-attention');
      expect(persisted?.data.needsAttentionPaths).toContain('draft.ts');
      expect(persisted?.data.compensatedPaths).toContain('disk.txt');
    } finally {
      database.close();
    }
  });

  it('rejects a stale disk source before dispatching any surface path', async () => {
    harness = await createDocumentAuthorityHarness();
    const activeHarness = harness;
    await bindDurableCatalog(activeHarness);
    const live = new Map<string, LiveSurfaceBuffer>();
    const surface = attachLiveSurfaceCompleter(activeHarness.authority, {
      generation: 1,
      live,
      ownerId: 'surface-owner',
      workspaceId: activeHarness.identity.workspaceId,
    });
    try {
      await fs.promises.writeFile(path.join(activeHarness.workspaceRoot, 'draft.ts'), 'disk\n');
      await fs.promises.writeFile(path.join(activeHarness.workspaceRoot, 'other.ts'), 'disk\n');
      const disk = await activeHarness.authority.read(activeHarness.resource('draft.ts'));
      if (disk.status !== 'ready') throw new Error('Expected disk fixture');
      const binding = {
        baseRevision: disk.revision,
        localEditRevision: 2,
        documentInstanceId: 'document-instance',
        bufferHash: hashSurfaceText('draft\n'),
        encoding: 'utf-8' as const,
        bom: false,
        lineEnding: 'lf' as const,
        resource: activeHarness.resource('draft.ts'),
      };
      live.set('draft.ts', { ...binding, content: 'draft\n' });
      await activeHarness.authority.publishDirtyBuffers({
        generation: 1,
        ownerId: 'surface-owner',
        resources: [binding],
        workspaceId: activeHarness.identity.workspaceId,
      });
      const context = await activeHarness.authority.captureAgentInputSnapshot({
        generation: 1,
        ownerId: 'surface-owner',
        sessionId: 'session-stale-source',
        workspaceId: activeHarness.identity.workspaceId,
        resources: [{ ...binding, content: 'draft\n' }],
      });
      activeHarness.authority.commitAgentInputSnapshot('session-stale-source', context);
      const result = await activeHarness.authority.applyAgentSurfaceWrite('session-stale-source', context, [
        { resourceId: 'draft.ts', action: 'edit', edits: [{ oldText: 'draft\n', newText: 'changed\n' }] },
        {
          resourceId: 'other.ts',
          action: 'write',
          content: 'new\n',
          expectedHash: hashSurfaceText('source-before\n'),
        },
      ]);
      expect(result.status).toBe('conflict');
      expect(live.get('draft.ts')?.content).toBe('draft\n');
      if (result.status === 'disk' || !result.operationId) throw new Error('Expected durable stale operation');
      const recoveryRoot = path.join(activeHarness.dataDir, 'agent-mutation-catalog');
      const database = await reopenCatalog(recoveryRoot);
      try {
        expect(inspectAgentMutationOperation(database, result.operationId)?.state).toBe('aborted');
      } finally {
        database.close();
      }
    } finally {
      surface.close();
    }
  });
});
