import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDocumentAuthority } from './authority.js';
import { DocumentPathError, DocumentUntrustedError } from './errors.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async (probe, timeoutMs = 8000) => {
  const started = Date.now();
  let lastError;
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

const operationId = () => `op-${Math.random().toString(36).slice(2)}`;

export const createDocumentAuthorityHarness = async (overrides = {}) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'piarium-documents-'));
  const workspaceRoot = path.join(root, 'workspace');
  const dataDir = path.join(root, 'data');
  await fs.promises.mkdir(workspaceRoot, { recursive: true });
  let trusted = overrides.trusted ?? true;
  const allowedRootInput = overrides.allowedRoot ?? workspaceRoot;
  const allowedRoot = await fs.promises.realpath(allowedRootInput);
  const authority = createDocumentAuthority({
    hostId: overrides.hostId ?? '11111111-1111-4111-8111-111111111111',
    dataDir,
    isTrusted: async () => trusted,
    isAllowedRoot: async (candidate) => {
      const normalized = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
      const allowed = process.platform === 'win32' ? allowedRoot.toLowerCase() : allowedRoot;
      return normalized === allowed || normalized.startsWith(`${allowed}${path.sep}`);
    },
    overflowLimit: overrides.overflowLimit ?? 256,
    ...(overrides.authority ?? {}),
  });
  const identity = await authority.resolveWorkspace({ path: workspaceRoot });
  return {
    authority,
    identity,
    root,
    workspaceRoot,
    dataDir,
    setTrusted: (value) => {
      trusted = value;
    },
    resource: (resourceId) => ({ workspaceId: identity.workspaceId, resourceId }),
    async cleanup() {
      // Windows keeps a directory handle open until every child process that touched it has fully
      // exited, so removal races with process teardown and fails with EBUSY. `force` only ignores
      // a missing path, so ask for the retry backoff that covers a busy one.
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
};

export const defineDocumentAuthorityContract = ({ describe, it, expect, beforeEach, afterEach }) => {
  describe('document authority contract', () => {
    let harness;

    beforeEach(async () => {
      harness = await createDocumentAuthorityHarness();
    });

    afterEach(async () => {
      await harness?.cleanup();
    });

    it('distinguishes missing, empty, binary, and read failure', async () => {
      const missing = await harness.authority.read(harness.resource('missing.txt'));
      expect(missing).toEqual({ status: 'missing', resource: harness.resource('missing.txt') });

      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'empty.txt'), '');
      const empty = await harness.authority.read(harness.resource('empty.txt'));
      expect(empty.status).toBe('ready');
      expect(empty.content).toBe('');
      expect(empty.byteLength).toBe(0);

      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'binary.bin'), Buffer.from([0, 1, 2, 0, 9]));
      const binary = await harness.authority.read(harness.resource('binary.bin'));
      expect(binary.status).toBe('binary');
      expect(binary.content).toBeUndefined();

      const fsPromises = {
        ...fs.promises,
        readFile: async (target, encoding) => {
          if (String(target).includes('denied.txt')) {
            const error = new Error('EACCES: permission denied');
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
        resource,
        content: 'hello\n',
        encoding: 'utf-8',
        bom: false,
        expectedRevision: null,
        operationId: operationId(),
      });
      expect(written.status).toBe('written');
      const conflict = await harness.authority.write({
        resource,
        content: 'other',
        encoding: 'utf-8',
        bom: false,
        expectedRevision: null,
        operationId: operationId(),
      });
      expect(conflict.status).toBe('conflict');
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
        resource,
        content: 'first-write',
        encoding: 'utf-8',
        bom: false,
        expectedRevision: current.status === 'ready' ? current.revision : null,
        operationId: operationId(),
      });
      const secondWrite = harness.authority.write({
        resource,
        content: 'second-write',
        encoding: 'utf-8',
        bom: false,
        expectedRevision: current.status === 'ready' ? current.revision : null,
        operationId: operationId(),
      });
      const results = await Promise.all([firstWrite, secondWrite]);
      expect(results.filter((result) => result.status === 'written').length).toBeGreaterThanOrEqual(1);
      const final = await harness.authority.read(resource);
      expect(final.status).toBe('ready');
      expect(['first-write', 'second-write']).toContain(final.content);
    });

    it('watches created, changed, moved, deleted, and reset events without file bodies', async () => {
      const events = [];
      const subscription = harness.authority.watch(harness.identity.workspaceId, (event) => {
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
        if (error?.code === 'EPERM') {
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
      const originalWrite = fs.promises.writeFile.bind(fs.promises);
      fs.promises.writeFile = async (...args) => {
        if (String(args[0]).includes('document-recovery') && String(args[0]).includes('.tmp')) {
          throw new Error('disk full');
        }
        return originalWrite(...args);
      };
      try {
        await expect(harness.authority.writeRecoveryJournal({
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
        fs.promises.writeFile = originalWrite;
      }
    });
  });
};
