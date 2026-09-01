import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createSerialQueues } from './serialize.js';

const SCHEMA_VERSION = 2;

const journalFileName = (journalId) => `${journalId}.json`;

const assertPathSegment = (value, label) => {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/\0]/.test(value)) {
    throw new TypeError(`${label} is malformed`);
  }
  return value;
};

const summarize = (record) => ({
  journalId: record.journalId,
  resource: record.resource,
  revision: record.revision,
  baseRevision: record.baseRevision,
  epoch: record.epoch,
  updatedAt: record.updatedAt,
  byteLength: Buffer.byteLength(record.content, 'utf8'),
});

const parseRecord = (raw, journalId, expected) => {
  if (!raw || raw.schemaVersion !== SCHEMA_VERSION) return { status: 'malformed', journalId };
  if (typeof raw.journalId !== 'string' || raw.journalId !== journalId) return { status: 'malformed', journalId };
  if (!raw.resource || typeof raw.resource.workspaceId !== 'string' || typeof raw.resource.resourceId !== 'string') {
    return { status: 'malformed', journalId };
  }
  if (typeof raw.content !== 'string' || typeof raw.encoding !== 'string' || typeof raw.bom !== 'boolean') {
    return { status: 'malformed', journalId };
  }
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 1) return { status: 'malformed', journalId };
  if (!Number.isSafeInteger(raw.epoch) || raw.epoch < 1) return { status: 'malformed', journalId };
  if (raw.baseRevision !== null && typeof raw.baseRevision !== 'string') return { status: 'malformed', journalId };
  if (typeof raw.updatedAt !== 'string' || typeof raw.recoverySessionId !== 'string') {
    return { status: 'malformed', journalId };
  }
  if (raw.hostId !== expected.hostId
    || (expected.workspaceId && raw.workspaceId !== expected.workspaceId)
    || (expected.recoverySessionId && raw.recoverySessionId !== expected.recoverySessionId)
    || raw.resource.workspaceId !== raw.workspaceId) {
    return { status: 'malformed', journalId };
  }
  return { status: 'ready', record: raw };
};

export const createRecoveryJournalStore = ({
  rootDir,
  hostId,
  fsPromises,
  pathModule = path,
}) => {
  const queues = createSerialQueues();
  const directoryFor = (workspaceId, recoverySessionId) => pathModule.join(
    rootDir,
    assertPathSegment(hostId, 'hostId'),
    assertPathSegment(workspaceId, 'workspaceId'),
    assertPathSegment(recoverySessionId, 'recoverySessionId'),
  );

  const readFile = async (filePath, journalId, expected = {}) => {
    try {
      const raw = JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
      return parseRecord(raw, journalId, { hostId, ...expected });
    } catch (error) {
      if (error?.code === 'ENOENT') return { status: 'missing', journalId };
      if (error instanceof SyntaxError) return { status: 'malformed', journalId };
      throw error;
    }
  };

  const findJournal = async (journalId, requestedWorkspaceId) => {
    assertPathSegment(journalId, 'journalId');
    const hostDir = pathModule.join(rootDir, assertPathSegment(hostId, 'hostId'));
    let workspaces = [];
    try {
      workspaces = await fsPromises.readdir(hostDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    for (const workspaceEntry of workspaces) {
      if (!workspaceEntry.isDirectory()) continue;
      if (requestedWorkspaceId && workspaceEntry.name !== requestedWorkspaceId) continue;
      const workspaceId = assertPathSegment(workspaceEntry.name, 'workspaceId');
      const workspaceDir = pathModule.join(hostDir, workspaceId);
      const sessions = await fsPromises.readdir(workspaceDir, { withFileTypes: true });
      for (const sessionEntry of sessions) {
        if (!sessionEntry.isDirectory()) continue;
        const recoverySessionId = assertPathSegment(sessionEntry.name, 'recoverySessionId');
        const filePath = pathModule.join(workspaceDir, recoverySessionId, journalFileName(journalId));
        const parsed = await readFile(filePath, journalId, { workspaceId, recoverySessionId });
        if (parsed.status === 'missing') continue;
        return { filePath, parsed, workspaceId, recoverySessionId };
      }
    }
    return null;
  };

  const atomicWrite = async (filePath, record) => {
    await fsPromises.mkdir(pathModule.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fsPromises.writeFile(tmp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
      await fsPromises.rename(tmp, filePath);
    } catch (error) {
      await fsPromises.unlink(tmp).catch(() => undefined);
      throw error;
    }
  };

  return {
    async list({ workspaceId, recoverySessionId }) {
      assertPathSegment(workspaceId, 'workspaceId');
      if (recoverySessionId !== undefined) assertPathSegment(recoverySessionId, 'recoverySessionId');
      const summaries = [];
      const base = recoverySessionId
        ? [directoryFor(workspaceId, recoverySessionId)]
        : [];
      if (!recoverySessionId) {
        const workspaceDir = pathModule.join(rootDir, hostId, workspaceId);
        let sessions = [];
        try {
          sessions = await fsPromises.readdir(workspaceDir, { withFileTypes: true });
        } catch (error) {
          if (error?.code === 'ENOENT') return [];
          throw error;
        }
        for (const entry of sessions) {
          if (entry.isDirectory()) base.push(pathModule.join(workspaceDir, entry.name));
        }
      }

      for (const directory of base) {
        let files = [];
        try {
          files = await fsPromises.readdir(directory);
        } catch (error) {
          if (error?.code === 'ENOENT') continue;
          throw error;
        }
        for (const name of files) {
          if (!name.endsWith('.json') || name.includes('.tmp.')) continue;
          const journalId = name.slice(0, -'.json'.length);
          const sessionId = pathModule.basename(directory);
          const parsed = await readFile(pathModule.join(directory, name), journalId, {
            workspaceId,
            recoverySessionId: sessionId,
          });
          if (parsed.status === 'ready') summaries.push(summarize(parsed.record));
        }
      }
      return summaries;
    },

    async read(journalId) {
      const found = await findJournal(journalId);
      if (!found) return { status: 'missing', journalId };
      const { parsed } = found;
      if (parsed.status !== 'ready') return parsed;
      return {
        status: 'ready',
        journal: summarize(parsed.record),
        content: parsed.record.content,
        encoding: parsed.record.encoding,
        bom: parsed.record.bom,
      };
    },

    async write(request) {
      assertPathSegment(request.workspaceId, 'workspaceId');
      assertPathSegment(request.recoverySessionId, 'recoverySessionId');
      if (!request.resource || request.resource.workspaceId !== request.workspaceId
        || typeof request.resource.resourceId !== 'string') {
        throw new TypeError('Recovery journal resource does not match its workspace');
      }
      const targetKey = `${request.workspaceId}\0${request.recoverySessionId}\0${request.resource.resourceId}`;
      return queues.run(targetKey, async () => {
        const directory = directoryFor(request.workspaceId, request.recoverySessionId);
        await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
        const existingNames = await fsPromises.readdir(directory).catch((error) => {
          if (error?.code === 'ENOENT') return [];
          throw error;
        });
        let existing = null;
        for (const name of existingNames) {
          if (!name.endsWith('.json')) continue;
          const parsed = await readFile(pathModule.join(directory, name), name.slice(0, -'.json'.length), {
            workspaceId: request.workspaceId,
            recoverySessionId: request.recoverySessionId,
          });
          if (parsed.status !== 'ready') continue;
          if (
            parsed.record.resource.workspaceId === request.resource.workspaceId
            && parsed.record.resource.resourceId === request.resource.resourceId
            && parsed.record.epoch === request.token.epoch
          ) {
            existing = parsed.record;
            break;
          }
        }

        if (existing) {
          if (request.expectedRevision !== existing.revision) {
            return { status: 'conflict', journal: summarize(existing) };
          }
          const record = {
            ...existing,
            content: request.content,
            encoding: request.encoding,
            bom: request.bom,
            baseRevision: request.baseRevision,
            revision: existing.revision + 1,
            updatedAt: new Date().toISOString(),
          };
          await atomicWrite(pathModule.join(directory, journalFileName(existing.journalId)), record);
          return { status: 'written', journal: summarize(record) };
        }

        if (request.expectedRevision !== null) {
          return { status: 'missing', journalId: '' };
        }

        const record = {
          schemaVersion: SCHEMA_VERSION,
          journalId: randomUUID(),
          hostId,
          workspaceId: request.workspaceId,
          recoverySessionId: request.recoverySessionId,
          resource: request.resource,
          content: request.content,
          encoding: request.encoding,
          bom: request.bom,
          baseRevision: request.baseRevision,
          epoch: request.token.epoch,
          revision: 1,
          updatedAt: new Date().toISOString(),
        };
        await atomicWrite(pathModule.join(directory, journalFileName(record.journalId)), record);
        return { status: 'written', journal: summarize(record) };
      });
    },

    async delete({ journalId, expectedRevision, token }) {
      const workspaceId = assertPathSegment(token?.workspaceId, 'workspaceId');
      const found = await findJournal(journalId, workspaceId);
      if (!found || found.parsed.status !== 'ready') return { status: 'missing' };
      const targetKey = `${workspaceId}\0${found.recoverySessionId}\0${found.parsed.record.resource.resourceId}`;
      return queues.run(targetKey, async () => {
        const current = await readFile(found.filePath, journalId, {
          workspaceId,
          recoverySessionId: found.recoverySessionId,
        });
        if (current.status !== 'ready') return { status: 'missing' };
        if (current.record.revision !== expectedRevision) {
          return { status: 'conflict', journal: summarize(current.record) };
        }
        await fsPromises.unlink(found.filePath);
        return { status: 'deleted' };
      });
    },
  };
};
