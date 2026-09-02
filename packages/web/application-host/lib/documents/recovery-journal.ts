import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createSerialQueues } from './serialize.js';

const SCHEMA_VERSION = 2;

interface DocumentResource {
  workspaceId: string;
  resourceId: string;
}

interface JournalRecord {
  schemaVersion: number;
  journalId: string;
  hostId: string;
  workspaceId: string;
  recoverySessionId: string;
  resource: DocumentResource;
  content: string;
  encoding: string;
  bom: boolean;
  baseRevision: string | null;
  epoch: number;
  revision: number;
  updatedAt: string;
}

export interface JournalSummary {
  journalId: string;
  resource: DocumentResource;
  revision: number;
  baseRevision: string | null;
  epoch: number;
  updatedAt: string;
  byteLength: number;
}

interface MutationToken {
  workspaceId: string;
  epoch: number;
  owner: unknown;
}

export interface RecoveryJournalWriteRequest {
  workspaceId: string;
  recoverySessionId: string;
  resource: DocumentResource;
  content: string;
  encoding: string;
  bom: boolean;
  baseRevision: string | null;
  expectedRevision: number | null;
  token: MutationToken;
}

export interface RecoveryJournalDeleteRequest {
  journalId: string;
  expectedRevision: number;
  token: MutationToken;
}

export interface RecoveryJournalListRequest {
  workspaceId: string;
  recoverySessionId?: string;
}

type ParsedRecord =
  | { status: 'malformed'; journalId: string }
  | { status: 'missing'; journalId: string }
  | { status: 'ready'; record: JournalRecord };

interface FoundJournal {
  filePath: string;
  parsed: ParsedRecord;
  workspaceId: string;
  recoverySessionId: string;
}

interface ExpectedMatch {
  hostId?: string;
  workspaceId?: string;
  recoverySessionId?: string;
}

const journalFileName = (journalId: string): string => `${journalId}.json`;

const assertPathSegment = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/\0]/.test(value)) {
    throw new TypeError(`${label} is malformed`);
  }
  return value;
};

const summarize = (record: JournalRecord): JournalSummary => ({
  journalId: record.journalId,
  resource: record.resource,
  revision: record.revision,
  baseRevision: record.baseRevision,
  epoch: record.epoch,
  updatedAt: record.updatedAt,
  byteLength: Buffer.byteLength(record.content, 'utf8'),
});

const parseRecord = (raw: unknown, journalId: string, expected: ExpectedMatch): ParsedRecord => {
  if (!raw || typeof raw !== 'object' || (raw as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION) {
    return { status: 'malformed', journalId };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.journalId !== 'string' || r.journalId !== journalId) return { status: 'malformed', journalId };
  const resource = r.resource as Record<string, unknown> | undefined;
  if (!resource || typeof resource.workspaceId !== 'string' || typeof resource.resourceId !== 'string') {
    return { status: 'malformed', journalId };
  }
  if (typeof r.content !== 'string' || typeof r.encoding !== 'string' || typeof r.bom !== 'boolean') {
    return { status: 'malformed', journalId };
  }
  if (!Number.isSafeInteger(r.revision) || (r.revision as number) < 1) return { status: 'malformed', journalId };
  if (!Number.isSafeInteger(r.epoch) || (r.epoch as number) < 1) return { status: 'malformed', journalId };
  if (r.baseRevision !== null && typeof r.baseRevision !== 'string') return { status: 'malformed', journalId };
  if (typeof r.updatedAt !== 'string' || typeof r.recoverySessionId !== 'string') {
    return { status: 'malformed', journalId };
  }
  if (r.hostId !== expected.hostId
    || (expected.workspaceId && r.workspaceId !== expected.workspaceId)
    || (expected.recoverySessionId && r.recoverySessionId !== expected.recoverySessionId)
    || (resource as { workspaceId: string }).workspaceId !== r.workspaceId) {
    return { status: 'malformed', journalId };
  }
  return { status: 'ready', record: r as unknown as JournalRecord };
};

export interface RecoveryJournalStoreOptions {
  rootDir: string;
  hostId: string;
  fsPromises: Pick<typeof import('node:fs/promises'), 'mkdir' | 'readFile' | 'readdir' | 'rename' | 'unlink' | 'writeFile'>;
  pathModule?: typeof path;
}

export const createRecoveryJournalStore = ({
  rootDir,
  hostId,
  fsPromises,
  pathModule = path,
}: RecoveryJournalStoreOptions) => {
  const queues = createSerialQueues();
  const directoryFor = (workspaceId: string, recoverySessionId: string): string => pathModule.join(
    rootDir,
    assertPathSegment(hostId, 'hostId'),
    assertPathSegment(workspaceId, 'workspaceId'),
    assertPathSegment(recoverySessionId, 'recoverySessionId'),
  );

  const readFile = async (filePath: string, journalId: string, expected: ExpectedMatch = {}): Promise<ParsedRecord> => {
    try {
      const raw = JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
      return parseRecord(raw, journalId, { hostId, ...expected });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { status: 'missing', journalId };
      if (error instanceof SyntaxError) return { status: 'malformed', journalId };
      throw error;
    }
  };

  const findJournal = async (journalId: string, requestedWorkspaceId?: string): Promise<FoundJournal | null> => {
    assertPathSegment(journalId, 'journalId');
    const hostDir = pathModule.join(rootDir, assertPathSegment(hostId, 'hostId'));
    let workspaces: import('node:fs').Dirent[];
    try {
      workspaces = await fsPromises.readdir(hostDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
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

  const atomicWrite = async (filePath: string, record: JournalRecord): Promise<void> => {
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
    async list({ workspaceId, recoverySessionId }: RecoveryJournalListRequest): Promise<JournalSummary[]> {
      assertPathSegment(workspaceId, 'workspaceId');
      if (recoverySessionId !== undefined) assertPathSegment(recoverySessionId, 'recoverySessionId');
      const summaries: JournalSummary[] = [];
      const base: string[] = recoverySessionId
        ? [directoryFor(workspaceId, recoverySessionId)]
        : [];
      if (!recoverySessionId) {
        const workspaceDir = pathModule.join(rootDir, hostId, workspaceId);
        let sessions: import('node:fs').Dirent[];
        try {
          sessions = await fsPromises.readdir(workspaceDir, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
          throw error;
        }
        for (const entry of sessions) {
          if (entry.isDirectory()) base.push(pathModule.join(workspaceDir, entry.name));
        }
      }

      for (const directory of base) {
        let files: string[];
        try {
          files = await fsPromises.readdir(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
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

    async read(journalId: string): Promise<
      | { status: 'malformed'; journalId: string }
      | { status: 'missing'; journalId: string }
      | { status: 'ready'; journal: JournalSummary; content: string; encoding: string; bom: boolean }
    > {
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

    async write(request: RecoveryJournalWriteRequest): Promise<
      | { status: 'conflict'; journal: JournalSummary }
      | { status: 'missing'; journalId: string }
      | { status: 'written'; journal: JournalSummary }
    > {
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
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [] as string[];
          throw error;
        });
        let existing: JournalRecord | null = null;
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
          const record: JournalRecord = {
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

        const record: JournalRecord = {
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

    async delete({ journalId, expectedRevision, token }: RecoveryJournalDeleteRequest): Promise<
      | { status: 'missing' }
      | { status: 'conflict'; journal: JournalSummary }
      | { status: 'deleted' }
    > {
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
