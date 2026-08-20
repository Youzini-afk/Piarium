import { isDocumentAuthorityError } from '../documents/errors.js';
import { createFsSearchRuntime } from '../fs/search.js';
import { createWorkspaceContentSearch } from './content.js';

const sendError = (res, error) => {
  if (isDocumentAuthorityError(error)) {
    return res.status(error.statusCode).json({
      error: error.message,
      reason: error.code,
    });
  }
  const message = error instanceof Error ? error.message : 'Search request failed';
  return res.status(500).json({ error: message, reason: 'failed' });
};

const readBody = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

const resolveSearchDirectory = async ({
  req,
  directory,
  path,
  os,
  normalizeDirectoryPath,
  resolveProjectDirectory,
}) => {
  const raw = typeof directory === 'string' ? directory.trim() : '';
  const resolvedProject = await resolveProjectDirectory(req);
  const fallback = resolvedProject?.resolved
    || (typeof os.homedir === 'function' ? os.homedir() : process.cwd());
  const target = raw
    ? (path.isAbsolute(raw) ? raw : path.resolve(fallback, raw))
    : fallback;
  const normalized = typeof normalizeDirectoryPath === 'function'
    ? normalizeDirectoryPath(target)
    : target;
  if (resolvedProject?.resolved) {
    const root = resolvedProject.resolved;
    const relative = path.relative(root, normalized);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      const error = new Error('Search directory is outside the workspace');
      error.statusCode = 403;
      error.code = 'path-escape';
      throw error;
    }
  }
  return normalized;
};

export const registerWorkspaceSearchRoutes = (app, {
  documents,
  uiAuthController,
  fsPromises,
  path,
  os,
  spawn,
  resolveGitBinaryForSpawn,
  normalizeDirectoryPath,
  resolveProjectDirectory,
  env = process.env,
}) => {
  const requireAuth = uiAuthController?.requireAuth
    ?? ((_req, _res, next) => next());
  const fileSearch = createFsSearchRuntime({
    fsPromises,
    path,
    spawn,
    resolveGitBinaryForSpawn,
  });
  const contentSearch = createWorkspaceContentSearch({
    documents,
    spawn,
    pathModule: path,
    env,
  });

  app.get('/api/find/file', requireAuth, async (req, res) => {
    try {
      const query = typeof req.query?.query === 'string' ? req.query.query : '';
      const directory = await resolveSearchDirectory({
        req,
        directory: req.query?.directory,
        path,
        os,
        normalizeDirectoryPath,
        resolveProjectDirectory,
      });
      const limit = Number.parseInt(String(req.query?.limit ?? ''), 10);
      const includeHidden = req.query?.includeHidden === 'true';
      const respectGitignore = req.query?.respectGitignore !== 'false';
      const files = await fileSearch.searchFilesystemFiles(directory, {
        query,
        limit: Number.isFinite(limit) && limit > 0 ? limit : 80,
        includeHidden,
        respectGitignore,
      });
      return res.json(files.map((file) => file.relativePath));
    } catch (error) {
      if (error?.code === 'path-escape') {
        return res.status(403).json({ error: error.message, reason: 'path-escape' });
      }
      return sendError(res, error);
    }
  });

  app.post('/api/workspace/search/content', requireAuth, async (req, res) => {
    const body = readBody(req);
    const generation = Number.parseInt(String(req.headers['x-piarium-generation'] ?? ''), 10);
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.on('aborted', onClose);
    res.on('close', onClose);
    try {
      const result = await contentSearch.searchContent(body, {
        generation: Number.isFinite(generation) ? generation : 0,
        signal: controller.signal,
      });
      return res.json(result);
    } catch (error) {
      return sendError(res, error);
    } finally {
      req.off?.('aborted', onClose);
      res.off?.('close', onClose);
    }
  });

  return { contentSearch, fileSearch };
};
