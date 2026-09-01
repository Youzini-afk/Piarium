import fs from 'fs';
import multer from 'multer';
import os from 'os';
import path from 'path';
import { createProjectIdFromPath } from '../projects/project-id.js';
import { createWorkspaceConfig } from './workspace-config.js';
import { resolveWorkspacePath } from './path-safety.js';
import {
  extractWorkspaceArchive,
  previewWorkspaceArchive,
} from './archive.js';
import {
  createWorkspaceFile,
  createWorkspaceFolder,
  deleteWorkspaceEntry,
  getWorkspaceEntry,
  getWorkspaceRootInfo,
  listWorkspaceDirectory,
  moveWorkspaceEntry,
  uploadWorkspaceFiles,
  uploadWorkspaceMultipartFiles,
} from './filesystem.js';
import { getWorkspaceDownloadInfo, resolveWorkspaceDownload } from './download.js';
import {
  getWorkspaceGitStatus,
  workspaceGitCheckout,
  workspaceGitClone,
  workspaceGitCommit,
  workspaceGitFetch,
  workspaceGitLog,
  workspaceGitPull,
  workspaceGitPush,
  workspaceGitRemotes,
} from './git.js';

const getRequestPath = (req) => {
  const candidate = typeof req.query?.path === 'string'
    ? req.query.path
    : (typeof req.body?.path === 'string' ? req.body.path : '');
  return candidate;
};

const DOWNLOAD_OPTIONS = { dotfiles: 'allow' };

const toErrorStatus = (error) => {
  if (Number.isInteger(error?.statusCode)) return error.statusCode;
  if (error?.code === 'ENOENT') return 404;
  if (error?.code === 'EEXIST') return 409;
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 403;
  if (error?.name === 'MulterError') return 413;
  return 500;
};

const sendError = (res, error) => {
  const status = toErrorStatus(error);
  if (status >= 500) {
    console.error('[workspace] request failed:', error);
  }
  return res.status(status).json({
    error: error?.message || 'Workspace request failed',
  });
};

const createRouteContext = (dependencies) => {
  const fsPromises = dependencies.fsPromises || fs.promises;
  const pathModule = dependencies.pathModule || dependencies.path || path;
  const osModule = dependencies.osModule || dependencies.os || os;
  const env = dependencies.env || process.env;
  const config = createWorkspaceConfig({
    env,
    cwd: dependencies.cwd || process.cwd(),
    pathModule,
    osModule,
  });

  return { config, fsPromises, pathModule, osModule, documents: dependencies.documents };
};

const runWorkspaceMutation = (context, ownerId, operation, options = {}) => {
  if (typeof context.documents?.runMutationForScope !== 'function') return operation();
  return context.documents.runMutationForScope(
    context.config.root,
    { kind: 'web-route', id: ownerId },
    operation,
    options,
  );
};

const readTree = async (relativePath, depth, context) => {
  const current = await listWorkspaceDirectory(relativePath, context.config, context);
  if (depth <= 0) {
    return current;
  }

  const entries = [];
  for (const entry of current.entries) {
    if (entry.type !== 'directory') {
      entries.push(entry);
      continue;
    }
    const child = await readTree(entry.relativePath, depth - 1, context).catch(() => null);
    entries.push({
      ...entry,
      ...(child ? { children: child.entries } : {}),
    });
  }

  return {
    ...current,
    entries,
  };
};

const openWorkspaceProject = async (relativePathValue, dependencies, context) => {
  const {
    readSettingsFromDisk = async () => ({}),
    persistSettings = async (changes) => changes,
    sanitizeProjects = (value) => Array.isArray(value) ? value : [],
  } = dependencies;

  const resolved = await resolveWorkspacePath(relativePathValue, {
    root: context.config.root,
    fsPromises: context.fsPromises,
    pathModule: context.pathModule,
  });
  const stat = await context.fsPromises.stat(resolved.absolutePath);
  if (!stat.isDirectory()) {
    const error = new Error('Only workspace directories can be opened as projects');
    error.statusCode = 400;
    throw error;
  }

  const settings = await readSettingsFromDisk();
  const projects = sanitizeProjects(settings?.projects || []);
  const projectId = createProjectIdFromPath(resolved.absolutePath);
  const now = Date.now();
  const existing = projects.find((project) => project.id === projectId || project.path === resolved.absolutePath);
  const label = context.pathModule.basename(resolved.absolutePath) || resolved.absolutePath;
  const project = existing
    ? { ...existing, id: projectId, path: resolved.absolutePath, lastOpenedAt: now }
    : {
        id: projectId,
        path: resolved.absolutePath,
        label,
        addedAt: now,
        lastOpenedAt: now,
      };
  const nextProjects = existing
    ? projects.map((entry) => (entry === existing ? project : entry))
    : [...projects, project];

  const saved = await persistSettings({
    projects: nextProjects,
    activeProjectId: projectId,
    lastDirectory: resolved.absolutePath,
  });

  return {
    success: true,
    project,
    settings: saved,
  };
};

export const registerWorkspaceRoutes = (app, dependencies = {}) => {
  const context = createRouteContext(dependencies);
  const multipartUpload = multer({
    storage: multer.memoryStorage(),
    defParamCharset: 'utf8',
    limits: {
      fileSize: context.config.maxUploadBytes,
      files: 1000,
      fieldSize: 1024 * 1024,
    },
  });

  const parseMultipartUpload = (req, res) => new Promise((resolve, reject) => {
    multipartUpload.array('files')(req, res, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(req.files || []);
    });
  });

  app.get('/api/workspace/root', async (_req, res) => {
    try {
      res.json(await getWorkspaceRootInfo(context.config, context));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/workspace/list', async (req, res) => {
    try {
      res.json(await listWorkspaceDirectory(getRequestPath(req), context.config, context));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/workspace/tree', async (req, res) => {
    try {
      const depthRaw = Number.parseInt(String(req.query?.depth ?? '2'), 10);
      const depth = Number.isFinite(depthRaw) ? Math.min(Math.max(depthRaw, 0), 6) : 2;
      res.json(await readTree(getRequestPath(req), depth, context));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/workspace/entry', async (req, res) => {
    try {
      res.json(await getWorkspaceEntry(getRequestPath(req), context.config, context));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/workspace/folder', async (req, res) => {
    try {
      res.json(await runWorkspaceMutation(
        context,
        'workspace.folder',
        () => createWorkspaceFolder(getRequestPath(req), context.config, context),
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/workspace/file', async (req, res) => {
    try {
      res.json(await runWorkspaceMutation(
        context,
        'workspace.file',
        () => createWorkspaceFile(getRequestPath(req), context.config, {
          ...context,
          content: req.body?.content ?? '',
        }),
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.patch('/api/workspace/move', async (req, res) => {
    try {
      const from = req.body?.from ?? req.body?.oldPath;
      const to = req.body?.to ?? req.body?.newPath;
      res.json(await runWorkspaceMutation(
        context,
        'workspace.move',
        () => moveWorkspaceEntry(from, to, context.config, context),
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.delete('/api/workspace/entry', async (req, res) => {
    try {
      res.json(await runWorkspaceMutation(
        context,
        'workspace.delete',
        () => deleteWorkspaceEntry(getRequestPath(req), context.config, {
          ...context,
          permanent: req.body?.permanent === true,
        }),
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/workspace/upload', async (req, res) => {
    try {
      if (req.is('multipart/form-data')) {
        const files = await parseMultipartUpload(req, res);
        res.json(await runWorkspaceMutation(
          context,
          'workspace.upload',
          () => uploadWorkspaceMultipartFiles(getRequestPath(req), files, context.config, context),
        ));
        return;
      }
      res.json(await runWorkspaceMutation(
        context,
        'workspace.upload',
        () => uploadWorkspaceFiles(getRequestPath(req), req.body?.files, context.config, context),
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/workspace/archive/preview', async (req, res) => {
    try {
      res.json(await previewWorkspaceArchive(getRequestPath(req), context.config, context));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/workspace/archive/extract', async (req, res) => {
    try {
      res.json(await runWorkspaceMutation(
        context,
        'workspace.archive.extract',
        () => extractWorkspaceArchive(req.body, context.config, context),
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/workspace/download/check', async (req, res) => {
    try {
      res.json(await getWorkspaceDownloadInfo(getRequestPath(req), context.config, context));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/workspace/download', async (req, res) => {
    try {
      const download = await resolveWorkspaceDownload(getRequestPath(req), context.config, context);
      if (download.type === 'file') {
        return res.download(download.filePath, download.fileName, DOWNLOAD_OPTIONS);
      }

      res.attachment(download.fileName);
      res.type('zip');
      download.stream.on('error', (error) => {
        if (!res.headersSent) {
          sendError(res, error);
          return;
        }
        res.destroy(error);
      });
      return download.stream.pipe(res);
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/workspace/projects/open', async (req, res) => {
    try {
      res.json(await openWorkspaceProject(getRequestPath(req), dependencies, context));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/workspace/git/status', async (req, res) => {
    try {
      const mode = req.query?.mode === 'light' ? { mode: 'light' } : {};
      res.json(await getWorkspaceGitStatus(getRequestPath(req), context.config, { ...context, options: mode }));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/workspace/git/fetch', async (req, res) => {
    try {
      res.json(await runWorkspaceMutation(
        context,
        'workspace.git.fetch',
        () => workspaceGitFetch(getRequestPath(req), req.body, context.config, context),
        { mode: 'process', purpose: 'workspace-git-fetch' },
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/workspace/git/clone', async (req, res) => {
    try {
      res.json(await runWorkspaceMutation(
        context,
        'workspace.git.clone',
        () => workspaceGitClone(getRequestPath(req), req.body, context.config, context),
        { mode: 'process', purpose: 'workspace-git-clone' },
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/workspace/git/pull', async (req, res) => {
    try {
      res.json(await runWorkspaceMutation(
        context,
        'workspace.git.pull',
        () => workspaceGitPull(getRequestPath(req), req.body, context.config, context),
        { mode: 'process', purpose: 'workspace-git-pull' },
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/workspace/git/push', async (req, res) => {
    try {
      res.json(await runWorkspaceMutation(
        context,
        'workspace.git.push',
        () => workspaceGitPush(getRequestPath(req), req.body, context.config, context),
        { mode: 'process', purpose: 'workspace-git-push' },
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/workspace/git/checkout', async (req, res) => {
    try {
      const branch = String(req.body?.branch || '').trim();
      if (!branch) return res.status(400).json({ error: 'branch is required' });
      res.json(await runWorkspaceMutation(
        context,
        'workspace.git.checkout',
        () => workspaceGitCheckout(getRequestPath(req), branch, context.config, context),
        { mode: 'process', purpose: 'workspace-git-checkout' },
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/workspace/git/commit', async (req, res) => {
    try {
      res.json(await runWorkspaceMutation(
        context,
        'workspace.git.commit',
        () => workspaceGitCommit(getRequestPath(req), req.body, context.config, context),
        { mode: 'process', purpose: 'workspace-git-commit' },
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/workspace/git/log', async (req, res) => {
    try {
      res.json(await workspaceGitLog(getRequestPath(req), req.query, context.config, context));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/workspace/git/remotes', async (req, res) => {
    try {
      res.json(await workspaceGitRemotes(getRequestPath(req), context.config, context));
    } catch (error) {
      sendError(res, error);
    }
  });
};
