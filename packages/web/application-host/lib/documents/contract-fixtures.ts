import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExpectStatic } from 'vitest';
import { createDocumentAuthority } from './authority.js';
import { DocumentPathError, DocumentUntrustedError } from './errors.js';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async <T>(probe: () => T | Promise<T>, timeoutMs = 8000): Promise<T> => {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(20);
  }
  throw lastError ?? new Error('Timed out waiting for document authority condition');
};

const operationId = (): string => `op-${Math.random().toString(36).slice(2)}`;

interface DocumentResource {
  workspaceId: string;
  resourceId: string;
}

interface DocumentTokenOwner {
  kind: string;
  id: string;
}

interface DocumentToken {
  workspaceId: string;
  epoch: number;
  owner: DocumentTokenOwner;
}

interface DocumentAuthorityHarnessOverrides {
  trusted?: boolean | undefined;
  allowedRoot?: string | undefined;
  hostId?: string | undefined;
  overflowLimit?: number | undefined;
  authority?: Record<string, unknown> | undefined;
}

interface DocumentAuthorityHarness {
  // The authority is produced by `createDocumentAuthority` (still authored in
  // JavaScript with `checkJs` disabled), so its members are intentionally
  // untyped here. Test fixtures lean on this loose surface.
  authority: any;
  identity: any;
  root: string;
  workspaceRoot: string;
  dataDir: string;
  setTrusted: (value: boolean) => void;
  resource: (resourceId: string) => DocumentResource;
  token: (epoch?: number, owner?: DocumentTokenOwner) => DocumentToken;
  cleanup: () => Promise<void>;
}

export const createDocumentAuthorityHarness = async (
  overrides: DocumentAuthorityHarnessOverrides = {},
): Promise<DocumentAuthorityHarness> => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'piarium-documents-'));
  const workspaceRoot = path.join(root, 'workspace');
  const dataDir = path.join(root, 'data');
  await fs.promises.mkdir(workspaceRoot, { recursive: true });
  let trusted: boolean = overrides.trusted ?? true;
  const allowedRootInput = overrides.allowedRoot ?? workspaceRoot;
  const allowedRoot = await fs.promises.realpath(allowedRootInput);
  const authority = createDocumentAuthority({
    hostId: overrides.hostId ?? '11111111-1111-4111-8111-111111111111',
    dataDir,
    isTrusted: async () => trusted,
    isAllowedRoot: async (candidate: string) => {
      const normalized = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
      const allowed = process.platform === 'win32' ? allowedRoot.toLowerCase() : allowedRoot;
      return normalized === allowed || normalized.startsWith(`${allowed}${path.sep}`);
    },
    overflowLimit: overrides.overflowLimit ?? 256,
    ...(overrides.authority ?? {}),
  });
  // `resolveWorkspace` is authored in JavaScript and its inferred return type
  // includes `| undefined` (the catch branch falls through). The harness always
  // resolves a fresh workspace before use, so we treat the identity as defined.
  const identity: any = await authority.resolveWorkspace({ path: workspaceRoot });
  return {
    authority,
    identity,
    root,
    workspaceRoot,
    dataDir,
    setTrusted: (value: boolean) => {
      trusted = value;
    },
    resource: (resourceId: string) => ({ workspaceId: identity.workspaceId, resourceId }),
    token: (
      epoch: number = identity.epoch,
      owner: DocumentTokenOwner = { kind: 'test', id: 'document-contract' },
    ) => ({
      workspaceId: identity.workspaceId,
      epoch,
      owner,
    }),
    async cleanup() {
      await authority.dispose();
      // Windows keeps a directory handle open until every child process that touched it has fully
      // exited, so removal races with process teardown and fails with EBUSY. `force` only ignores
      // a missing path, so ask for the retry backoff that covers a busy one.
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
};

interface DocumentAuthorityContractContext {
  describe: (...args: any[]) => void;
  it: (...args: any[]) => void;
  expect: ExpectStatic;
  beforeEach: (...args: any[]) => void;
  afterEach: (...args: any[]) => void;
}

export const defineDocumentAuthorityContract = ({
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
}: DocumentAuthorityContractContext): void => {
  describe('document authority contract', () => {
    let harness: any;

    beforeEach(async () => {
      harness = await createDocumentAuthorityHarness();
    });

    afterEach(async () => {
      await harness?.cleanup();
    });

    it('distinguishes missing, empty, binary, and read failure', async () => {
      const missing = await harness.authority.read(harness.resource('missing.txt'));
      expect(missing).toEqual({
        status: 'missing',
        epoch: harness.identity.epoch,
        resource: harness.resource('missing.txt'),
      });

      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'empty.txt'), '');
      const empty = await harness.authority.read(harness.resource('empty.txt'));
      expect(empty.status).toBe('ready');
      expect(empty.content).toBe('');
      expect(empty.byteLength).toBe(0);

      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'binary.bin'), Buffer.from([0, 1, 2, 0, 9]));
      const binary = await harness.authority.read(harness.resource('binary.bin'));
      expect(binary.status).toBe('binary');
      expect(binary.content).toBeUndefined();

      const fsPromises: any = {
        ...fs.promises,
        readFile: async (target: any, encoding?: any) => {
          if (String(target).includes('denied.txt')) {
            const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
            error.code = 'EACCES';
            throw error;
          }
          return fs.promises.readFile(target, encoding);
        },
      };
      await harness.cleanup();
      harness = await createDocumentAuthorityHarness({
        authority: { fsPromises },
      });
      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'denied.txt'), 'classified');
      await expect(harness.authority.read(harness.resource('denied.txt'))).rejects.toMatchObject({
        code: 'failed',
      });
      const stillMissing = await harness.authority.read(harness.resource('also-missing.txt'));
      expect(stillMissing.status).toBe('missing');
    });

    it('creates when expected revision is missing and conflicts when the file exists', async () => {
      const resource = harness.resource('created.txt');
      const written = await harness.authority.write({
        token: harness.token(),
        resource,
        content: 'hello\n',
        encoding: 'utf-8',
        bom: false,
        expectedRevision: null,
        operationId: operationId(),
      });
      expect(written.status).toBe('written');
      const conflict = await harness.authority.write({
        token: harness.token(),
        resource,
        content: 'other',
        encoding: 'utf-8',
        bom: false,
        expectedRevision: null,
        operationId: operationId(),
      });
      expect(conflict.status).toBe('conflict');
      expect(conflict.current.epoch).toBe(harness.identity.epoch);
      expect(conflict.current.content).toBeUndefined();
    });

    it('rejects stale revisions and detects same-mtime content changes', async () => {
      const filePath = path.join(harness.workspaceRoot, 'note.txt');
      await fs.promises.writeFile(filePath, 'alpha');
      const first = await harness.authority.read(harness.resource('note.txt'));
      expect(first.status).toBe('ready');
      const stat = await fs.promises.stat(filePath);
      await fs.promises.writeFile(filePath, 'bravo');
      await fs.promises.utimes(filePath, stat.atime, stat.mtime);
      const second = await harness.authority.read(harness.resource('note.txt'));
      expect(second.status).toBe('ready');
      expect(second.content).toBe('bravo');
      expect(second.revision).not.toBe(first.revision);
      const conflict = await harness.authority.write({
        token: harness.token(),
        resource: harness.resource('note.txt'),
        content: 'charlie',
        encoding: 'utf-8',
        bom: false,
        expectedRevision: first.revision,
        operationId: operationId(),
      });
      expect(conflict.status).toBe('conflict');
    });

    it('serializes mutations so overlapping read/write operations do not tear', async () => {
      const filePath = path.join(harness.workspaceRoot, 'race.txt');
      await fs.promises.writeFile(filePath, 'start');
      const resource = harness.resource('race.txt');
      const firstRead = harness.authority.read(resource);
      const current = await firstRead;
      const firstWrite = harness.authority.write({
        token: harness.token(),
        resource,
        content: 'first-write',
        encoding: 'utf-8',
        bom: false,
        expectedRevision: current.status === 'ready' ? current.revision : null,
        operationId: operationId(),
      });
      const secondWrite = harness.authority.write({
        token: harness.token(),
        resource,
        content: 'second-write',
        encoding: 'utf-8',
        bom: false,
        expectedRevision: current.status === 'ready' ? current.revision : null,
        operationId: operationId(),
      });
      const results = await Promise.all([firstWrite, secondWrite]);
      expect(results.filter((result: any) => result.status === 'written').length).toBeGreaterThanOrEqual(1);
      const final = await harness.authority.read(resource);
      expect(final.status).toBe('ready');
      expect(['first-write', 'second-write']).toContain(final.content);
    });

    it('preserves the previous document when atomic replacement fails', async () => {
      await harness.cleanup();
      const fsPromises: any = {
        ...fs.promises,
        rename: async (source: any, destination: any) => {
          if (String(source).includes('.piarium-tmp-') && String(destination).endsWith('protected.txt')) {
            const error = new Error('EPERM: replacement denied') as NodeJS.ErrnoException;
            error.code = 'EPERM';
            throw error;
          }
          return fs.promises.rename(source, destination);
        },
      };
      harness = await createDocumentAuthorityHarness({ authority: { fsPromises } });
      const filePath = path.join(harness.workspaceRoot, 'protected.txt');
      await fs.promises.writeFile(filePath, 'original');
      const current = await harness.authority.read(harness.resource('protected.txt'));
      expect(current.status).toBe('ready');

      await expect(harness.authority.write({
        token: harness.token(),
        resource: harness.resource('protected.txt'),
        content: 'replacement',
        encoding: 'utf-8',
        bom: false,
        expectedRevision: current.revision,
        operationId: operationId(),
      })).rejects.toMatchObject({ code: 'failed' });

      expect(await fs.promises.readFile(filePath, 'utf8')).toBe('original');
      expect((await fs.promises.readdir(harness.workspaceRoot)).some((entry) => entry.includes('.piarium-tmp-'))).toBe(false);
    });

    it('fences document and journal mutations by persisted workspace epoch', async () => {
      const note = harness.resource('fenced.txt');
      const first = await harness.authority.write({
        token: harness.token(),
        resource: note,
        content: 'epoch-one',
        encoding: 'utf-8',
        bom: false,
        expectedRevision: null,
        operationId: operationId(),
      });
      expect(first.status).toBe('written');
      const journal = await harness.authority.writeRecoveryJournal({
        token: harness.token(),
        workspaceId: harness.identity.workspaceId,
        recoverySessionId: 'session-fenced',
        resource: note,
        content: 'draft-one',
        encoding: 'utf-8',
        bom: false,
        baseRevision: first.revision,
        expectedRevision: null,
      });
      expect(journal.status).toBe('written');
      expect(journal.journal.epoch).toBe(harness.identity.epoch);

      const active = await harness.authority.registerWriter(harness.token(), { purpose: 'test-active' });
      await expect(harness.authority.advanceEpoch(harness.identity.workspaceId, { maintenance: false }))
        .rejects.toMatchObject({ code: 'active-writer' });
      await active.close();

      const advanced = await harness.authority.advanceEpoch(harness.identity.workspaceId, { maintenance: false });
      expect(advanced.epoch).toBe(harness.identity.epoch + 1);
      const staleWrite = await harness.authority.write({
        token: harness.token(),
        resource: note,
        content: 'stale-write',
        encoding: 'utf-8',
        bom: false,
        expectedRevision: first.revision,
        operationId: operationId(),
      });
      expect(staleWrite).toEqual({ status: 'stale-epoch', currentEpoch: advanced.epoch });
      expect(await fs.promises.readFile(path.join(harness.workspaceRoot, 'fenced.txt'), 'utf8')).toBe('epoch-one');
      expect(await harness.authority.move({
        token: harness.token(),
        from: note,
        to: harness.resource('moved.txt'),
        expectedRevision: first.revision,
        operationId: operationId(),
      })).toEqual({ status: 'stale-epoch', currentEpoch: advanced.epoch });
      expect(await harness.authority.delete({
        token: harness.token(),
        resource: note,
        expectedRevision: first.revision,
        operationId: operationId(),
      })).toEqual({ status: 'stale-epoch', currentEpoch: advanced.epoch });
      expect(await harness.authority.writeRecoveryJournal({
        token: harness.token(),
        workspaceId: harness.identity.workspaceId,
        recoverySessionId: 'session-fenced',
        resource: note,
        content: 'stale-draft',
        encoding: 'utf-8',
        bom: false,
        baseRevision: first.revision,
        expectedRevision: journal.journal.revision,
      })).toEqual({ status: 'stale-epoch', currentEpoch: advanced.epoch });
      expect(await harness.authority.deleteRecoveryJournal({
        token: harness.token(),
        journalId: journal.journal.journalId,
        expectedRevision: journal.journal.revision,
      })).toEqual({ status: 'stale-epoch', currentEpoch: advanced.epoch });

      const freshToken = harness.token(advanced.epoch);
      const freshJournal = await harness.authority.writeRecoveryJournal({
        token: freshToken,
        workspaceId: harness.identity.workspaceId,
        recoverySessionId: 'session-fenced',
        resource: note,
        content: 'epoch-two-draft',
        encoding: 'utf-8',
        bom: false,
        baseRevision: first.revision,
        expectedRevision: null,
      });
      expect(freshJournal.status).toBe('written');
      expect(freshJournal.journal.epoch).toBe(advanced.epoch);
      const journalHistory = await harness.authority.listRecoveryJournals({
        workspaceId: harness.identity.workspaceId,
        recoverySessionId: 'session-fenced',
      });
      expect(journalHistory.some((entry: any) => entry.epoch === harness.identity.epoch)).toBe(true);
      expect(journalHistory.some((entry: any) => entry.epoch === advanced.epoch)).toBe(true);
      const fresh = await harness.authority.write({
        token: freshToken,
        resource: note,
        content: 'epoch-two',
        encoding: 'utf-8',
        bom: false,
        expectedRevision: first.revision,
        operationId: operationId(),
      });
      expect(fresh.status).toBe('written');
      const restarted = createDocumentAuthority({
        hostId: harness.authority.hostId,
        dataDir: harness.dataDir,
        isTrusted: async () => true,
        isAllowedRoot: async () => true,
      });
      const persisted = await restarted.inspectMutation(harness.identity.workspaceId);
      expect(persisted.epoch).toBe(advanced.epoch);
      await restarted.dispose();
    });

    it('binds mutation tokens to the target workspace and gates new writers during maintenance', async () => {
      const resource = harness.resource('workspace-bound.txt');
      const wrongToken = {
        ...harness.token(),
        workspaceId: '22222222-2222-4222-8222-222222222222',
      };
      await expect(harness.authority.write({
        token: wrongToken,
        resource,
        content: 'must-not-write',
        encoding: 'utf-8',
        bom: false,
        expectedRevision: null,
        operationId: operationId(),
      })).rejects.toMatchObject({ statusCode: 400 });
      await expect(fs.promises.stat(path.join(harness.workspaceRoot, 'workspace-bound.txt')))
        .rejects.toMatchObject({ code: 'ENOENT' });

      const active = await harness.authority.registerWriter(harness.token(), { purpose: 'maintenance-drain' });
      const maintenance = await harness.authority.setMaintenance(harness.identity.workspaceId, true);
      expect(maintenance.maintenance).toBe(true);
      expect(maintenance.activeWriters).toHaveLength(1);
      await expect(harness.authority.registerWriter(harness.token(), { purpose: 'late-writer' }))
        .rejects.toMatchObject({ code: 'maintenance' });
      await active.close();
      const advanced = await harness.authority.advanceEpoch(harness.identity.workspaceId, {
        expectedEpoch: harness.identity.epoch,
      });
      expect(advanced.epoch).toBe(harness.identity.epoch + 1);
      await expect(harness.authority.advanceEpoch(harness.identity.workspaceId, {
        expectedEpoch: harness.identity.epoch,
      })).rejects.toMatchObject({ code: 'stale-epoch', currentEpoch: advanced.epoch });
      await harness.authority.setMaintenance(harness.identity.workspaceId, false);
    });

    it('tracks legacy Host mutations by canonical workspace scope', async () => {
      const nested = path.join(harness.workspaceRoot, 'nested-cwd');
      await fs.promises.mkdir(nested);
      expect(await harness.authority.resolveScopeId(nested)).toBe(harness.identity.workspaceId);
      expect(await harness.authority.resolveScopeId(path.join(nested, 'not-created-yet')))
        .toBe(harness.identity.workspaceId);
      const before = await harness.authority.inspectMutation(harness.identity.workspaceId);
      await harness.authority.runMutationForScope(
        harness.workspaceRoot,
        { kind: 'host-route', id: 'legacy-fixture' },
        () => fs.promises.writeFile(path.join(harness.workspaceRoot, 'legacy.txt'), 'tracked'),
      );
      const after = await harness.authority.inspectMutation(harness.identity.workspaceId);
      expect(after.mutationRevision).toBeGreaterThan(before.mutationRevision);

      await harness.authority.setMaintenance(harness.identity.workspaceId, true);
      await expect(harness.authority.runMutationForScope(
        harness.workspaceRoot,
        { kind: 'host-route', id: 'maintenance-rejected' },
        () => fs.promises.writeFile(path.join(harness.workspaceRoot, 'late.txt'), 'late'),
      )).rejects.toMatchObject({ code: 'maintenance' });
      await expect(fs.promises.stat(path.join(harness.workspaceRoot, 'late.txt')))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await harness.authority.setMaintenance(harness.identity.workspaceId, false);
    });

    it('tracks live dirty buffers by surface owner and rejects stale generations', async () => {
      const publication = await harness.authority.publishDirtyBuffers({
        generation: 2,
        ownerId: 'surface-1',
        resources: [{
          baseRevision: null,
          localEditRevision: 3,
          resource: harness.resource('dirty.txt'),
        }],
        workspaceId: harness.identity.workspaceId,
      });
      expect(publication).toMatchObject({ ownerId: 'surface-1', generation: 2 });
      const dirty = await harness.authority.inspectDirtyBuffers(harness.identity.workspaceId);
      expect(dirty).toHaveLength(1);
      expect(dirty[0].ownerId).toBe('surface-1');
      expect(dirty[0].resources[0].resource).toEqual(harness.resource('dirty.txt'));
      await expect(harness.authority.clearDirtyBuffers({
        generation: 1,
        ownerId: 'surface-1',
        workspaceId: harness.identity.workspaceId,
      })).rejects.toMatchObject({ code: 'stale-completion' });
      expect(await harness.authority.clearDirtyBuffers({
        generation: 2,
        ownerId: 'surface-1',
        workspaceId: harness.identity.workspaceId,
      })).toEqual({ cleared: true });
      expect(await harness.authority.inspectDirtyBuffers(harness.identity.workspaceId)).toEqual([]);
    });

    it('watches created, changed, moved, deleted, and reset events without file bodies', async () => {
      const events: any[] = [];
      const subscription = harness.authority.watch(harness.identity.workspaceId, (event: any) => {
        events.push(event);
      });
      await waitUntil(() => harness.authority.hasWatch(harness.identity.workspaceId));
      await wait(150);
      const filePath = path.join(harness.workspaceRoot, 'watched.txt');
      await fs.promises.writeFile(filePath, 'one');
      await waitUntil(() => events.some((event) => event.kind === 'created' && event.resource.resourceId === 'watched.txt'));
      await fs.promises.writeFile(filePath, 'two');
      await waitUntil(() => events.some((event) => event.kind === 'changed' && event.resource.resourceId === 'watched.txt'));
      await fs.promises.rename(filePath, path.join(harness.workspaceRoot, 'renamed.txt'));
      await waitUntil(() => events.some((event) => (
        event.kind === 'moved'
        || (event.kind === 'deleted' && event.resource.resourceId === 'watched.txt')
      )));
      await fs.promises.unlink(path.join(harness.workspaceRoot, 'renamed.txt'));
      await waitUntil(() => events.some((event) => event.kind === 'deleted'));
      expect(JSON.stringify(events)).not.toContain('one');
      expect(JSON.stringify(events)).not.toContain('two');
      expect(harness.authority.emitWatchOverflow(harness.identity.workspaceId)).toBe(true);
      await waitUntil(() => events.some((event) => event.kind === 'reset' && event.reason === 'overflow'));
      harness.authority.reconnectWatch(harness.identity.workspaceId);
      await waitUntil(() => events.some((event) => event.kind === 'reset' && event.reason === 'reconnected'));
      const overflowIndex = events.findIndex((event) => event.kind === 'reset' && event.reason === 'overflow');
      expect(events.slice(overflowIndex).filter((event) => event.kind === 'deleted')).toEqual([]);
      subscription.close();
    });

    it('rejects symlink escape, path traversal, and untrusted projects', async () => {
      await expect(harness.authority.read(harness.resource('../secret.txt'))).rejects.toBeInstanceOf(DocumentPathError);
      const outside = path.join(harness.root, 'outside.txt');
      await fs.promises.writeFile(outside, 'nope');
      const link = path.join(harness.workspaceRoot, 'escape.txt');
      try {
        await fs.promises.symlink(outside, link);
        await expect(harness.authority.read(harness.resource('escape.txt'))).rejects.toBeInstanceOf(DocumentPathError);
      } catch (error) {
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'EPERM') {
          // Windows without developer symlink privilege still covered by path traversal.
        } else {
          throw error;
        }
      }
      harness.setTrusted(false);
      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'trusted.txt'), 'ok');
      await expect(harness.authority.read(harness.resource('trusted.txt'))).rejects.toBeInstanceOf(DocumentUntrustedError);
    });

    it('treats missing, malformed, and failed recovery journals as distinct results', async () => {
      const missing = await harness.authority.readRecoveryJournal('missing-journal');
      expect(missing.status).toBe('missing');
      const resource = harness.resource('draft.txt');
      const written = await harness.authority.writeRecoveryJournal({
        token: harness.token(),
        workspaceId: harness.identity.workspaceId,
        recoverySessionId: 'session-1',
        resource,
        content: 'draft',
        encoding: 'utf-8',
        bom: false,
        baseRevision: null,
        expectedRevision: null,
      });
      expect(written.status).toBe('written');
      const listed = await harness.authority.listRecoveryJournals({
        workspaceId: harness.identity.workspaceId,
        recoverySessionId: 'session-1',
      });
      expect(listed).toHaveLength(1);
      const journalDir = path.join(
        harness.dataDir,
        'document-recovery',
        harness.authority.hostId,
        harness.identity.workspaceId,
        'session-1',
      );
      await fs.promises.writeFile(path.join(journalDir, 'broken.json'), '{not-json');
      const afterMalformed = await harness.authority.listRecoveryJournals({
        workspaceId: harness.identity.workspaceId,
        recoverySessionId: 'session-1',
      });
      expect(afterMalformed).toHaveLength(1);
      const originalWrite: any = fs.promises.writeFile.bind(fs.promises);
      (fs.promises as any).writeFile = async (...args: any[]) => {
        if (String(args[0]).includes('document-recovery') && String(args[0]).includes('.tmp')) {
          throw new Error('disk full');
        }
        return originalWrite(...args);
      };
      try {
        await expect(harness.authority.writeRecoveryJournal({
          token: harness.token(),
          workspaceId: harness.identity.workspaceId,
          recoverySessionId: 'session-1',
          resource: harness.resource('other.txt'),
          content: 'nope',
          encoding: 'utf-8',
          bom: false,
          baseRevision: null,
          expectedRevision: null,
        })).rejects.toThrow(/disk full/);
      } finally {
        (fs.promises as any).writeFile = originalWrite;
      }
      await expect(harness.authority.listRecoveryJournals({
        workspaceId: '../escape',
      })).rejects.toThrow(/workspaceId is malformed/);
      await expect(harness.authority.writeRecoveryJournal({
        token: harness.token(),
        workspaceId: harness.identity.workspaceId,
        recoverySessionId: '../escape',
        resource,
        content: 'nope',
        encoding: 'utf-8',
        bom: false,
        baseRevision: null,
        expectedRevision: null,
      })).rejects.toThrow(/recoverySessionId is malformed/);
    });
  });
};
