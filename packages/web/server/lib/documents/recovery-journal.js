import { randomUUID } from 'node:crypto';
import path from 'node:path';

const SCHEMA_VERSION = 1;

const journalFileName = (journalId) => `${journalId}.json`;

const summarize = (record) => ({
  journalId: record.journalId,
  resource: record.resource,
  revision: record.revision,
  baseRevision: record.baseRevision,
  updatedAt: record.updatedAt,
  byteLength: Buffer.byteLength(record.content, 'utf8'),
});

const parseRecord = (raw, journalId) => {
  if (!raw || raw.schemaVersion !== SCHEMA_VERSION) return { status: 'malformed', journalId };
  if (typeof raw.journalId !== 'string' || raw.journalId !== journalId) return { status: 'malformed', journalId };
  if (!raw.resource || typeof raw.resource.workspaceId !== 'string' || typeof raw.resource.resourceId !== 'string') {
    return { status: 'malformed', journalId };
  }
  if (typeof raw.content !== 'string' || typeof raw.encoding !== 'string' || typeof raw.bom !== 'boolean') {
    return { status: 'malformed', journalId };
  }
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 1) return { status: 'malformed', journalId };
  if (raw.baseRevision !== null && typeof raw.baseRevision !== 'string') return { status: 'malformed', journalId };
  if (typeof raw.updatedAt !== 'string' || typeof raw.recoverySessionId !== 'string') {
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
  const directoryFor = (workspaceId, recoverySessionId) => pathModule.join(
    rootDir,
    hostId,
    workspaceId,
    recoverySessionId,
  );

  const readFile = async (filePath, journalId) => {
    try {
      const raw = JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
      return parseRecord(raw, journalId);
    } catch (error) {
      if (error?.code === 'ENOENT') return { status: 'missing', journalId };
      if (error instanceof SyntaxError) return { status: 'malformed', journalId };
      throw error;
    }
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
          const parsed = await readFile(pathModule.join(directory, name), journalId);
          if (parsed.status === 'ready') summaries.push(summarize(parsed.record));
        }
      }
      return summaries;
    },

    async read(journalId) {
      const matches = [];
      const hostDir = pathModule.join(rootDir, hostId);
      const walk = async (directory, depth) => {
        if (depth > 4) return;
        let entries = [];
        try {
          entries = await fsPromises.readdir(directory, { withFileTypes: true });
        } catch (error) {
          if (error?.code === 'ENOENT') return;
          throw error;
        }
        for (const entry of entries) {
          const full = pathModule.join(directory, entry.name);
          if (entry.isDirectory()) await walk(full, depth + 1);
          else if (entry.name === journalFileName(journalId)) matches.push(full);
        }
      };
      await walk(hostDir, 0);
      if (matches.length === 0) return { status: 'missing', journalId };
      const parsed = await readFile(matches[0], journalId);
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
      const directory = directoryFor(request.workspaceId, request.recoverySessionId);
      await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
      const existingNames = await fsPromises.readdir(directory).catch((error) => {
        if (error?.code === 'ENOENT') return [];
        throw error;
      });
      let existing = null;
      for (const name of existingNames) {
        if (!name.endsWith('.json')) continue;
        const parsed = await readFile(pathModule.join(directory, name), name.slice(0, -'.json'.length));
        if (parsed.status !== 'ready') continue;
        if (
          parsed.record.resource.workspaceId === request.resource.workspaceId
          && parsed.record.resource.resourceId === request.resource.resourceId
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
        revision: 1,
        updatedAt: new Date().toISOString(),
      };
      await atomicWrite(pathModule.join(directory, journalFileName(record.journalId)), record);
      return { status: 'written', journal: summarize(record) };
    },

    async delete({ journalId, expectedRevision }) {
      const current = await this.read(journalId);
      if (current.status === 'missing') return { status: 'missing' };
      if (current.status === 'malformed') return { status: 'missing' };
      if (current.journal.revision !== expectedRevision) {
        return { status: 'conflict', journal: current.journal };
      }
      const hostDir = pathModule.join(rootDir, hostId);
      const remove = async (directory, depth) => {
        if (depth > 4) return false;
        let entries = [];
        try {
          entries = await fsPromises.readdir(directory, { withFileTypes: true });
        } catch (error) {
          if (error?.code === 'ENOENT') return false;
          throw error;
        }
        for (const entry of entries) {
          const full = pathModule.join(directory, entry.name);
          if (entry.isDirectory()) {
            if (await remove(full, depth + 1)) return true;
          } else if (entry.name === journalFileName(journalId)) {
            await fsPromises.unlink(full);
            return true;
          }
        }
        return false;
      };
      await remove(hostDir, 0);
      return { status: 'deleted' };
    },
  };
};
