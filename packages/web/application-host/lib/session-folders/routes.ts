const MAX_BODY_BYTES = 4 * 1024 * 1024;

const isObjectRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

interface SessionFolder {
  createdAt: number;
  id: string;
  name: string;
  parentId?: string | null | undefined;
  sessionIds: string[];
}

interface SessionFolderSnapshot extends Record<string, unknown> {
  collapsedFolderIds: string[];
  foldersMap: Record<string, SessionFolder[]>;
  updatedAt: number;
  version: 1;
}

const hasValidFolderShape = (folder: unknown): folder is SessionFolder => (
  isObjectRecord(folder)
  && typeof folder.id === 'string'
  && typeof folder.name === 'string'
  && Array.isArray(folder.sessionIds)
  && folder.sessionIds.every((sessionId) => typeof sessionId === 'string')
  && typeof folder.createdAt === 'number'
  && Number.isFinite(folder.createdAt)
  && (folder.parentId === undefined || folder.parentId === null || typeof folder.parentId === 'string')
);

const hasValidFoldersMapShape = (foldersMap: unknown): foldersMap is Record<string, SessionFolder[]> => (
  isObjectRecord(foldersMap)
  && Object.values(foldersMap).every((folders) => (
    Array.isArray(folders) && folders.every(hasValidFolderShape)
  ))
);

const hasValidFolderSnapshotShape = (snapshot: unknown): snapshot is SessionFolderSnapshot => (
  isObjectRecord(snapshot)
  && snapshot.version === 1
  && hasValidFoldersMapShape(snapshot.foldersMap)
  && Array.isArray(snapshot.collapsedFolderIds)
  && snapshot.collapsedFolderIds.every((folderId) => typeof folderId === 'string')
);

export interface SessionFolderRequest { body?: unknown }
export interface SessionFolderResponse {
  json(payload: unknown): unknown;
  status(code: number): SessionFolderResponse;
}
export type SessionFolderHandler = (
  request: SessionFolderRequest,
  response: SessionFolderResponse,
) => Promise<unknown>;
export interface SessionFolderApp {
  get(path: string, handler: SessionFolderHandler): unknown;
  post(path: string, handler: SessionFolderHandler): unknown;
}
export interface SessionFolderFsPromises {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  rename(oldPath: string, newPath: string): Promise<unknown>;
  unlink(path: string): Promise<unknown>;
  writeFile(path: string, value: string, encoding: 'utf8'): Promise<unknown>;
}
export interface SessionFolderRouteDependencies {
  fsPromises: SessionFolderFsPromises;
  path: Pick<typeof import('node:path'), 'dirname' | 'join'>;
  piariumDataDir: string;
}

const errorCode = (error: unknown): string | undefined => (
  error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
);

export const registerSessionFoldersRoutes = (
  app: SessionFolderApp,
  dependencies: SessionFolderRouteDependencies,
): void => {
  const {
    fsPromises,
    path,
    piariumDataDir,
  } = dependencies;

  const filePath = path.join(piariumDataDir, 'sessions-directories.json');
  let saveQueue: Promise<unknown> = Promise.resolve();

  const ensureDir = async (): Promise<void> => {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  };

  app.get('/api/session-folders', async (_req, res) => {
    try {
      const raw = await fsPromises.readFile(filePath, 'utf8').catch((error) => {
        if (errorCode(error) === 'ENOENT') return null;
        throw error;
      });
      if (!raw) {
        return res.json({ version: 1, exists: false });
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (
          !hasValidFolderSnapshotShape(parsed)
          || typeof parsed.updatedAt !== 'number'
          || !Number.isFinite(parsed.updatedAt)
          || parsed.updatedAt <= 0
        ) {
          return res.status(500).json({ error: 'Stored session folders have an invalid shape' });
        }
        return res.json({ ...parsed, exists: true });
      } catch {
        return res.status(500).json({ error: 'Stored session folders are malformed' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read session folders';
      return res.status(500).json({ error: message });
    }
  });

  app.post('/api/session-folders', async (req, res) => {
    const body = req.body;
    if (!isObjectRecord(body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    if (!hasValidFolderSnapshotShape(body)) {
      return res.status(400).json({ error: 'Invalid session folders payload' });
    }
    const serialized = JSON.stringify(body, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BODY_BYTES) {
      return res.status(413).json({ error: 'Payload too large' });
    }
    if (typeof body.updatedAt !== 'number' || !Number.isFinite(body.updatedAt) || body.updatedAt <= 0) {
      return res.status(400).json({ error: 'updatedAt must be a positive finite number' });
    }

    const save = async (): Promise<unknown> => {
      let tmp: string | undefined;
      let saved = false;
      try {
        const currentRaw = await fsPromises.readFile(filePath, 'utf8').catch((error) => {
          if (errorCode(error) === 'ENOENT') return null;
          throw error;
        });
        if (currentRaw) {
          try {
            const current = JSON.parse(currentRaw) as unknown;
            const currentUpdatedAt = hasValidFolderSnapshotShape(current)
              && typeof current.updatedAt === 'number'
              && Number.isFinite(current.updatedAt)
              ? current.updatedAt
              : 0;
            if (currentUpdatedAt >= body.updatedAt) {
              return res.json({ success: true, ignored: true });
            }
          } catch { /* A valid new snapshot repairs malformed prior state. */ }
        }

        await ensureDir();
        tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        await fsPromises.writeFile(tmp, serialized, 'utf8');
        await fsPromises.rename(tmp, filePath);
        saved = true;
        return res.json({ success: true });
      } catch (error) {
        if (tmp && !saved) {
          await fsPromises.unlink(tmp).catch(() => undefined);
        }
        const message = error instanceof Error ? error.message : 'Failed to write session folders';
        return res.status(500).json({ error: message });
      }
    };

    const pendingSave = saveQueue.then(save, save);
    saveQueue = pendingSave.then(() => undefined, () => undefined);
    return pendingSave;
  });
};
