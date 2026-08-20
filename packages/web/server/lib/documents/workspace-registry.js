import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DocumentPathError } from './errors.js';

const SCHEMA_VERSION = 1;

const normalizeComparePath = (value, pathModule) => {
  const resolved = pathModule.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

const canonicalWorkspaceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const looksLikeCanonicalWorkspaceId = (value) => (
  typeof value === 'string' && canonicalWorkspaceIdPattern.test(value)
);

export const looksLikeFilesystemWorkspaceScopeId = (value) => (
  typeof value === 'string' && (/[\\/]/.test(value) || /^[A-Za-z]:/.test(value))
);

export const createWorkspaceRegistry = ({
  hostId,
  filePath,
  fsPromises,
  pathModule = path,
}) => {
  let queue = Promise.resolve();
  let document = null;

  const empty = () => ({
    schemaVersion: SCHEMA_VERSION,
    hostId,
    workspaces: [],
  });

  const read = async () => {
    if (document) return document;
    try {
      const raw = JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
      if (!raw || raw.hostId !== hostId || raw.schemaVersion !== SCHEMA_VERSION || !Array.isArray(raw.workspaces)) {
        document = empty();
        return document;
      }
      document = {
        schemaVersion: SCHEMA_VERSION,
        hostId,
        workspaces: raw.workspaces.filter((entry) => (
          entry
          && looksLikeCanonicalWorkspaceId(entry.workspaceId)
          && typeof entry.canonicalPath === 'string'
          && entry.canonicalPath.length > 0
        )),
      };
      return document;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      document = empty();
      return document;
    }
  };

  const persist = async (next) => {
    await fsPromises.mkdir(pathModule.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = JSON.stringify(next);
    try {
      await fsPromises.writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
      await fsPromises.rename(tmp, filePath);
      document = next;
    } catch (error) {
      await fsPromises.unlink(tmp).catch(() => undefined);
      throw error;
    }
  };

  const mutate = (work) => {
    const next = queue.then(async () => {
      const current = structuredClone(await read());
      const result = await work(current);
      await persist(current);
      return result;
    });
    queue = next.catch(() => undefined);
    return next;
  };

  const findByPath = (current, canonicalPath) => {
    const needle = normalizeComparePath(canonicalPath, pathModule);
    return current.workspaces.find((entry) => normalizeComparePath(entry.canonicalPath, pathModule) === needle);
  };

  return {
    async resolve({ canonicalPath, workspaceId, create }) {
      if (workspaceId) {
        const current = await read();
        const existing = current.workspaces.find((entry) => entry.workspaceId === workspaceId);
        if (!existing) return null;
        return { workspaceId: existing.workspaceId, canonicalPath: existing.canonicalPath, hostId };
      }
      if (!canonicalPath) throw new DocumentPathError('Workspace path is required', 400);
      return mutate((current) => {
        const existing = findByPath(current, canonicalPath);
        if (existing) {
          return { workspaceId: existing.workspaceId, canonicalPath: existing.canonicalPath, hostId };
        }
        if (!create) return null;
        const created = {
          workspaceId: randomUUID(),
          canonicalPath,
          createdAt: new Date().toISOString(),
        };
        current.workspaces.push(created);
        return { workspaceId: created.workspaceId, canonicalPath: created.canonicalPath, hostId };
      });
    },

    async get(workspaceId) {
      const current = await read();
      const existing = current.workspaces.find((entry) => entry.workspaceId === workspaceId);
      if (!existing) return null;
      return { workspaceId: existing.workspaceId, canonicalPath: existing.canonicalPath, hostId };
    },
  };
};
