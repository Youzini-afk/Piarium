const FULL_CONTROL_PROFILES = new Set(['full-control', 'external-agent', 'rescue']);
const MAX_READ_BYTES = 10 * 1024 * 1024;
const MAX_LIST_ENTRIES = 5000;
const MAX_COMMAND_BYTES = 2 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 10 * 60_000;

const EXTERNAL_CAPABILITIES = Object.freeze([
  'external-access.v1',
  'external-roots.v1',
  'external-fs.v1',
  'external-command.v1',
  'external-audit.v1',
]);

const toPosixPath = (value) => String(value || '').replace(/\\/g, '/');

const normalizeRootId = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
};

const normalizeRelativePath = (value, pathModule) => {
  if (typeof value !== 'string' || value.trim().length === 0) return '.';
  const trimmed = value.trim();
  if (pathModule.isAbsolute(trimmed)) return null;
  return trimmed;
};

const isPathWithinRoot = (candidate, rootPath, pathModule) => {
  const relative = pathModule.relative(rootPath, candidate);
  return relative === '' || (!relative.startsWith('..') && !pathModule.isAbsolute(relative));
};

const accessOk = async (fsPromises, targetPath) => {
  try {
    await fsPromises.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const realpathOrResolve = async (fsPromises, pathModule, targetPath) => {
  try {
    return await fsPromises.realpath(targetPath);
  } catch {
    return pathModule.resolve(targetPath);
  }
};

const resolveExistingAncestor = async (fsPromises, pathModule, targetPath) => {
  let current = pathModule.resolve(targetPath);
  while (current) {
    try {
      const realPath = await fsPromises.realpath(current);
      return { path: current, realPath };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = pathModule.dirname(current);
      if (!parent || parent === current) throw error;
      current = parent;
    }
  }
  const error = new Error('No existing parent directory found');
  error.statusCode = 404;
  throw error;
};

const findDeploymentRoot = async ({ fsPromises, pathModule, startPaths }) => {
  const seen = new Set();
  for (const startPath of startPaths) {
    if (typeof startPath !== 'string' || !startPath.trim()) continue;
    let current = pathModule.resolve(startPath);
    try {
      const stats = await fsPromises.stat(current);
      if (stats.isFile()) current = pathModule.dirname(current);
    } catch {
      // Keep walking from the resolved path; it may be an install root that
      // does not exist in tests.
    }

    while (current && !seen.has(current)) {
      seen.add(current);
      const packageJsonPath = pathModule.join(current, 'package.json');
      const webPackagePath = pathModule.join(current, 'packages', 'web', 'package.json');
      const gitPath = pathModule.join(current, '.git');
      if (
        await accessOk(fsPromises, packageJsonPath) &&
        (await accessOk(fsPromises, webPackagePath) || await accessOk(fsPromises, gitPath))
      ) {
        return realpathOrResolve(fsPromises, pathModule, current);
      }

      const parent = pathModule.dirname(current);
      if (!parent || parent === current) break;
      current = parent;
    }
  }

  return null;
};

const statRoot = async (fsPromises, root) => {
  try {
    const stats = await fsPromises.stat(root.path);
    return {
      ...root,
      exists: true,
      type: stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
      mtimeMs: stats.mtimeMs,
    };
  } catch (error) {
    return {
      ...root,
      exists: false,
      type: null,
      error: error?.message || 'Root is unavailable',
    };
  }
};

const uniqueRoots = (roots, pathModule) => {
  const byId = new Set();
  const byPath = new Set();
  const result = [];
  for (const root of roots) {
    if (!root?.id || !root?.path) continue;
    const id = normalizeRootId(root.id);
    const resolvedPath = pathModule.resolve(root.path);
    const key = resolvedPath.toLowerCase();
    if (byId.has(id) || byPath.has(key)) continue;
    byId.add(id);
    byPath.add(key);
    result.push({ ...root, id, path: resolvedPath });
  }
  return result;
};

const getClient = (req) => req.openchamberAuth?.client || null;

const getClientCapabilities = (client) => new Set(
  Array.isArray(client?.capabilities)
    ? client.capabilities.filter((entry) => typeof entry === 'string')
    : []
);

const hasCapability = (req, capability) => {
  const context = req.openchamberAuth;
  if (context?.type === 'session') return true;
  if (context?.type !== 'client') return false;
  const client = getClient(req);
  const profile = typeof client?.profile === 'string' ? client.profile : '';
  if (FULL_CONTROL_PROFILES.has(profile)) return true;
  const capabilities = getClientCapabilities(client);
  return capabilities.has('*') ||
    capabilities.has('admin') ||
    capabilities.has(capability) ||
    capabilities.has(capability.replace(/:[^:]+$/, ':*'));
};

const requireCapability = (req, res, capability) => {
  if (!req.openchamberAuth) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  if (!hasCapability(req, capability)) {
    res.status(403).json({ error: `External client is missing ${capability}` });
    return false;
  }
  return true;
};

const sendError = (res, error) => {
  const code = error?.code;
  const status = Number.isInteger(error?.statusCode)
    ? error.statusCode
    : code === 'ENOENT'
      ? 404
      : code === 'EACCES' || code === 'EPERM'
        ? 403
        : 500;
  if (status >= 500) {
    console.error('[external-access] request failed:', error);
  }
  return res.status(status).json({ error: error?.message || 'External access request failed' });
};

export const createExternalAccessRootRuntime = ({
  fsPromises,
  path,
  os,
  process,
  __dirname,
  openchamberDataDir,
  resolveProjectDirectory,
  deploymentRoot,
}) => {
  const resolveRoots = async (req) => {
    const envDeploymentRoot = typeof process.env.OPENCHAMBER_DEPLOYMENT_ROOT === 'string'
      ? process.env.OPENCHAMBER_DEPLOYMENT_ROOT.trim()
      : '';
    const serverPackageRoot = path.resolve(__dirname, '..');
    const discoveredDeploymentRoot = deploymentRoot
      || envDeploymentRoot
      || await findDeploymentRoot({
        fsPromises,
        pathModule: path,
        startPaths: [process.cwd(), __dirname, serverPackageRoot],
      })
      || process.cwd();
    const opencodeConfigDir = typeof process.env.OPENCODE_CONFIG_DIR === 'string' && process.env.OPENCODE_CONFIG_DIR.trim()
      ? process.env.OPENCODE_CONFIG_DIR.trim()
      : path.join(os.homedir(), '.config', 'opencode');

    const roots = [
      { id: 'deployment', label: 'OpenChamber deployment', path: discoveredDeploymentRoot, source: 'deployment' },
      { id: 'server-package', label: 'OpenChamber web package', path: serverPackageRoot, source: 'server-package' },
      { id: 'process-cwd', label: 'Server working directory', path: process.cwd(), source: 'process' },
      { id: 'data', label: 'OpenChamber data', path: openchamberDataDir, source: 'data' },
      { id: 'logs', label: 'OpenChamber logs', path: path.join(openchamberDataDir, 'logs'), source: 'logs' },
      { id: 'opencode-config', label: 'OpenCode config', path: opencodeConfigDir, source: 'opencode-config' },
    ];

    if (typeof resolveProjectDirectory === 'function') {
      const project = await resolveProjectDirectory(req).catch(() => null);
      if (project?.directory) {
        roots.unshift({ id: 'workspace', label: 'Active workspace', path: project.directory, source: 'workspace' });
      }
    }

    const client = getClient(req);
    const allowedDirectories = Array.isArray(client?.allowedDirectories) ? client.allowedDirectories : [];
    allowedDirectories.forEach((directory, index) => {
      roots.push({
        id: `client-${index + 1}`,
        label: `Client root ${index + 1}`,
        path: directory,
        source: 'client',
      });
    });

    return Promise.all(uniqueRoots(roots, path).map((root) => statRoot(fsPromises, root)));
  };

  const getRoot = async (req, rootId) => {
    const id = normalizeRootId(rootId || 'deployment');
    const roots = await resolveRoots(req);
    const root = roots.find((entry) => entry.id === id);
    if (!root) {
      const error = new Error(`Unknown external root: ${id || '<empty>'}`);
      error.statusCode = 404;
      throw error;
    }
    if (!root.exists || root.type !== 'directory') {
      const error = new Error(root.error || `External root is unavailable: ${id}`);
      error.statusCode = 404;
      throw error;
    }
    const realPath = await realpathOrResolve(fsPromises, path, root.path);
    return { ...root, realPath };
  };

  const resolvePath = async (req, { rootId, relativePath, mustExist = false, forWrite = false }) => {
    const root = await getRoot(req, rootId);
    const normalizedRelativePath = normalizeRelativePath(relativePath, path);
    if (normalizedRelativePath === null) {
      const error = new Error('Path must be relative to the selected root');
      error.statusCode = 400;
      throw error;
    }
    const candidate = path.resolve(root.realPath, normalizedRelativePath);
    if (!isPathWithinRoot(candidate, root.realPath, path)) {
      const error = new Error('Path is outside the selected root');
      error.statusCode = 403;
      throw error;
    }

    if (mustExist) {
      const canonical = await fsPromises.realpath(candidate);
      if (!isPathWithinRoot(canonical, root.realPath, path)) {
        const error = new Error('Path resolves outside the selected root');
        error.statusCode = 403;
        throw error;
      }
      return { root, absolutePath: canonical, relativePath: toPosixPath(path.relative(root.realPath, canonical)) || '.' };
    }

    if (forWrite) {
      const ancestor = await resolveExistingAncestor(fsPromises, path, candidate);
      if (!isPathWithinRoot(ancestor.realPath, root.realPath, path)) {
        const error = new Error('Write target resolves outside the selected root');
        error.statusCode = 403;
        throw error;
      }
      if (ancestor.path === candidate) {
        const targetRealPath = await fsPromises.realpath(candidate);
        if (!isPathWithinRoot(targetRealPath, root.realPath, path)) {
          const error = new Error('Write target resolves outside the selected root');
          error.statusCode = 403;
          throw error;
        }
      }
    }

    return { root, absolutePath: candidate, relativePath: toPosixPath(path.relative(root.realPath, candidate)) || '.' };
  };

  return {
    resolveRoots,
    resolvePath,
  };
};

const entryType = (stats) => stats.isDirectory()
  ? 'directory'
  : stats.isFile()
    ? 'file'
    : stats.isSymbolicLink()
      ? 'symlink'
      : 'other';

const listDirectory = async ({ fsPromises, path, root, absolutePath, depth, state }) => {
  if (state.count >= MAX_LIST_ENTRIES) return [];
  const dirents = await fsPromises.readdir(absolutePath, { withFileTypes: true });
  const entries = [];
  for (const dirent of dirents) {
    if (state.count >= MAX_LIST_ENTRIES) break;
    const childPath = path.join(absolutePath, dirent.name);
    let stats;
    try {
      stats = await fsPromises.lstat(childPath);
    } catch {
      continue;
    }
    state.count += 1;
    const relative = toPosixPath(path.relative(root.realPath, childPath));
    const entry = {
      name: dirent.name,
      path: relative,
      type: entryType(stats),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
    if (depth > 0 && stats.isDirectory()) {
      entry.children = await listDirectory({
        fsPromises,
        path,
        root,
        absolutePath: childPath,
        depth: depth - 1,
        state,
      });
    }
    entries.push(entry);
  }
  return entries;
};

const readFileContent = async ({ fsPromises, absolutePath, encoding }) => {
  const buffer = await fsPromises.readFile(absolutePath);
  if (buffer.byteLength > MAX_READ_BYTES) {
    const error = new Error(`File is too large to read through external access (${buffer.byteLength} bytes)`);
    error.statusCode = 413;
    throw error;
  }
  if (encoding === 'base64') {
    return { encoding: 'base64', content: buffer.toString('base64') };
  }
  return { encoding: 'utf8', content: buffer.toString('utf8') };
};

const normalizeTimeoutMs = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_COMMAND_TIMEOUT_MS;
  return Math.min(Math.max(parsed, 1000), MAX_COMMAND_TIMEOUT_MS);
};

const truncateOutput = (value) => {
  if (Buffer.byteLength(value, 'utf8') <= MAX_COMMAND_BYTES) {
    return { value, truncated: false };
  }
  return {
    value: Buffer.from(value).subarray(0, MAX_COMMAND_BYTES).toString('utf8'),
    truncated: true,
  };
};

const runCommand = ({ spawn, command, cwd, timeoutMs, env }) => new Promise((resolve) => {
  const isWin = process.platform === 'win32';
  const shell = isWin ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/sh');
  const args = isWin ? ['/d', '/s', '/c', command] : ['-lc', command];
  let stdout = '';
  let stderr = '';
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let timedOut = false;
  const child = spawn(shell, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGKILL');
    } catch {
    }
  }, timeoutMs);

  child.stdout?.on('data', (chunk) => {
    if (stdoutTruncated) return;
    const next = stdout + chunk.toString();
    const truncated = truncateOutput(next);
    stdout = truncated.value;
    stdoutTruncated = truncated.truncated;
  });
  child.stderr?.on('data', (chunk) => {
    if (stderrTruncated) return;
    const next = stderr + chunk.toString();
    const truncated = truncateOutput(next);
    stderr = truncated.value;
    stderrTruncated = truncated.truncated;
  });
  child.on('error', (error) => {
    clearTimeout(timeout);
    resolve({
      success: false,
      exitCode: null,
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
      error: error?.message || 'Command failed to start',
    });
  });
  child.on('close', (code, signal) => {
    clearTimeout(timeout);
    resolve({
      success: code === 0 && !timedOut,
      exitCode: Number.isInteger(code) ? code : null,
      signal: signal || null,
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
      timedOut,
      ...(timedOut ? { error: `Command timed out after ${timeoutMs}ms` } : {}),
    });
  });
});

export const registerExternalAccessRoutes = (app, dependencies = {}) => {
  const {
    fsPromises,
    path,
    os,
    process,
    spawn,
    buildAugmentedPath,
    openchamberDataDir,
    openchamberVersion,
    runtimeName,
    serverStartedAt,
    remoteClientAuthRuntime,
    resolveProjectDirectory,
    __dirname,
    deploymentRoot,
  } = dependencies;

  const rootRuntime = createExternalAccessRootRuntime({
    fsPromises,
    path,
    os,
    process,
    __dirname,
    openchamberDataDir,
    resolveProjectDirectory,
    deploymentRoot,
  });

  app.get('/api/external/me', (req, res) => {
    const context = req.openchamberAuth || null;
    if (!context) return res.status(401).json({ error: 'Authentication required' });
    return res.json({
      type: context.type,
      clientId: context.clientId || context.client?.id || null,
      client: context.client || null,
    });
  });

  app.get('/api/external/capabilities', (req, res) => {
    const context = req.openchamberAuth || null;
    if (!context) return res.status(401).json({ error: 'Authentication required' });
    const client = context.client || null;
    res.json({
      capabilities: EXTERNAL_CAPABILITIES,
      auth: {
        type: context.type,
        clientId: context.clientId || client?.id || null,
        profile: client?.profile || null,
        capabilities: Array.isArray(client?.capabilities) ? client.capabilities : [],
      },
      routes: [
        'GET /api/external/me',
        'GET /api/external/capabilities',
        'GET /api/external/status',
        'GET /api/external/roots',
        'GET /api/external/fs/list',
        'GET /api/external/fs/read',
        'PUT /api/external/fs/write',
        'POST /api/external/fs/folder',
        'DELETE /api/external/fs/entry',
        'POST /api/external/command',
        'GET /api/external/audit',
      ],
    });
  });

  app.get('/api/external/status', async (req, res) => {
    if (!requireCapability(req, res, 'instance:read')) return;
    try {
      res.json({
        openchamberVersion,
        runtime: runtimeName || 'web',
        startedAt: serverStartedAt || null,
        pid: process.pid,
        platform: process.platform,
        arch: process.arch,
        cwd: process.cwd(),
        dataDir: openchamberDataDir,
        node: process.version,
        uptimeSeconds: Math.round(process.uptime()),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/external/roots', async (req, res) => {
    if (!requireCapability(req, res, 'filesystem:read')) return;
    try {
      res.json({ roots: await rootRuntime.resolveRoots(req) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/external/fs/list', async (req, res) => {
    if (!requireCapability(req, res, 'filesystem:read')) return;
    try {
      const rootId = req.query?.root || 'deployment';
      const relativePath = req.query?.path || '.';
      const depthRaw = Number.parseInt(String(req.query?.depth ?? '0'), 10);
      const depth = Number.isFinite(depthRaw) ? Math.min(Math.max(depthRaw, 0), 6) : 0;
      const resolved = await rootRuntime.resolvePath(req, { rootId, relativePath, mustExist: true });
      const stats = await fsPromises.stat(resolved.absolutePath);
      if (!stats.isDirectory()) {
        return res.status(400).json({ error: 'Path is not a directory' });
      }
      const state = { count: 0 };
      const entries = await listDirectory({
        fsPromises,
        path,
        root: resolved.root,
        absolutePath: resolved.absolutePath,
        depth,
        state,
      });
      return res.json({
        root: resolved.root.id,
        path: resolved.relativePath,
        absolutePath: resolved.absolutePath,
        entries,
        truncated: state.count >= MAX_LIST_ENTRIES,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/external/fs/read', async (req, res) => {
    if (!requireCapability(req, res, 'filesystem:read')) return;
    try {
      const resolved = await rootRuntime.resolvePath(req, {
        rootId: req.query?.root || 'deployment',
        relativePath: req.query?.path || '.',
        mustExist: true,
      });
      const stats = await fsPromises.stat(resolved.absolutePath);
      if (!stats.isFile()) {
        return res.status(400).json({ error: 'Path is not a file' });
      }
      const content = await readFileContent({
        fsPromises,
        absolutePath: resolved.absolutePath,
        encoding: req.query?.encoding === 'base64' ? 'base64' : 'utf8',
      });
      return res.json({
        root: resolved.root.id,
        path: resolved.relativePath,
        absolutePath: resolved.absolutePath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ...content,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.put('/api/external/fs/write', async (req, res) => {
    if (!requireCapability(req, res, 'filesystem:write')) return;
    try {
      const body = req.body || {};
      const rootId = body.root || 'deployment';
      const relativePath = body.path || '.';
      if (typeof body.content !== 'string') {
        return res.status(400).json({ error: 'content must be a string' });
      }
      const candidate = await rootRuntime.resolvePath(req, { rootId, relativePath, mustExist: false });
      if (body.createParents !== false) {
        await fsPromises.mkdir(path.dirname(candidate.absolutePath), { recursive: true });
      }
      const resolved = await rootRuntime.resolvePath(req, { rootId, relativePath, mustExist: false, forWrite: true });
      const expectedMtimeMs = typeof body.expectedMtimeMs === 'number' ? body.expectedMtimeMs : null;
      if (expectedMtimeMs !== null) {
        try {
          const current = await fsPromises.stat(resolved.absolutePath);
          if (Math.abs(current.mtimeMs - expectedMtimeMs) > 1) {
            return res.status(409).json({ error: 'File was modified after it was read' });
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      const buffer = body.encoding === 'base64'
        ? Buffer.from(body.content, 'base64')
        : Buffer.from(body.content, 'utf8');
      await fsPromises.writeFile(resolved.absolutePath, buffer);
      const stats = await fsPromises.stat(resolved.absolutePath);
      return res.json({
        success: true,
        root: resolved.root.id,
        path: resolved.relativePath,
        absolutePath: resolved.absolutePath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/external/fs/folder', async (req, res) => {
    if (!requireCapability(req, res, 'filesystem:write')) return;
    try {
      const resolved = await rootRuntime.resolvePath(req, {
        rootId: req.body?.root || 'deployment',
        relativePath: req.body?.path || '.',
        mustExist: false,
        forWrite: true,
      });
      await fsPromises.mkdir(resolved.absolutePath, { recursive: true });
      const canonical = await rootRuntime.resolvePath(req, {
        rootId: req.body?.root || 'deployment',
        relativePath: req.body?.path || '.',
        mustExist: true,
      });
      return res.json({
        success: true,
        root: canonical.root.id,
        path: canonical.relativePath,
        absolutePath: canonical.absolutePath,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.delete('/api/external/fs/entry', async (req, res) => {
    if (!requireCapability(req, res, 'filesystem:delete')) return;
    try {
      const rootId = req.body?.root || req.query?.root || 'deployment';
      const relativePath = req.body?.path || req.query?.path || '';
      const normalizedRelativePath = normalizeRelativePath(relativePath, path);
      if (!normalizedRelativePath || normalizedRelativePath === '.') {
        return res.status(400).json({ error: 'Refusing to delete an external root directly' });
      }
      const resolved = await rootRuntime.resolvePath(req, { rootId, relativePath, mustExist: true });
      const stats = await fsPromises.lstat(resolved.absolutePath);
      const recursive = req.body?.recursive === true || req.query?.recursive === 'true';
      if (stats.isDirectory() && !recursive) {
        return res.status(400).json({ error: 'recursive=true is required to delete directories' });
      }
      await fsPromises.rm(resolved.absolutePath, { recursive, force: false });
      return res.json({
        success: true,
        root: resolved.root.id,
        path: resolved.relativePath,
        absolutePath: resolved.absolutePath,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/external/command', async (req, res) => {
    if (!requireCapability(req, res, 'terminal:use')) return;
    try {
      const command = typeof req.body?.command === 'string' ? req.body.command.trim() : '';
      if (!command) {
        return res.status(400).json({ error: 'command is required' });
      }
      if (command.length > 12_000) {
        return res.status(413).json({ error: 'command is too large' });
      }
      const rootId = req.body?.root || 'deployment';
      const cwdPath = req.body?.cwd || '.';
      const resolved = await rootRuntime.resolvePath(req, {
        rootId,
        relativePath: cwdPath,
        mustExist: true,
      });
      const stats = await fsPromises.stat(resolved.absolutePath);
      if (!stats.isDirectory()) {
        return res.status(400).json({ error: 'cwd is not a directory' });
      }
      const timeoutMs = normalizeTimeoutMs(req.body?.timeoutMs);
      const envPath = typeof buildAugmentedPath === 'function'
        ? buildAugmentedPath(process.env.PATH || '')
        : process.env.PATH;
      const result = await runCommand({
        spawn,
        command,
        cwd: resolved.absolutePath,
        timeoutMs,
        env: { ...process.env, PATH: envPath },
      });
      return res.json({
        ...result,
        root: resolved.root.id,
        cwd: resolved.relativePath,
        absoluteCwd: resolved.absolutePath,
        timeoutMs,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/external/audit', async (req, res) => {
    if (!requireCapability(req, res, 'instance:read')) return;
    try {
      const events = typeof remoteClientAuthRuntime?.listAuditEvents === 'function'
        ? await remoteClientAuthRuntime.listAuditEvents({ limit: req.query?.limit })
        : [];
      return res.json({ events });
    } catch (error) {
      return sendError(res, error);
    }
  });
};
