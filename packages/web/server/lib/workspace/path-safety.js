import fs from 'fs';
import path from 'path';

export class WorkspacePathError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'WorkspacePathError';
    this.statusCode = statusCode;
  }
}

const isWinDriveAbsolute = (value) => /^[A-Za-z]:[\\/]/.test(value);

const normalizeForCompare = (value, pathModule) => {
  const normalized = pathModule.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

export const isPathWithinRoot = (candidatePath, rootPath, pathModule = path) => {
  const candidate = normalizeForCompare(candidatePath, pathModule);
  const root = normalizeForCompare(rootPath, pathModule);
  const relative = pathModule.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !pathModule.isAbsolute(relative));
};

export const normalizeWorkspaceRelativePath = (value) => {
  if (value === undefined || value === null || value === '') {
    return '';
  }
  if (typeof value !== 'string') {
    throw new WorkspacePathError('Workspace path must be a string');
  }
  if (value.includes('\0')) {
    throw new WorkspacePathError('Invalid path: NUL bytes are not allowed');
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === '.') {
    return '';
  }
  if (path.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed) || isWinDriveAbsolute(trimmed)) {
    throw new WorkspacePathError('Workspace APIs require a relative path');
  }

  const segments = trimmed
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.');

  const normalized = [];
  for (const segment of segments) {
    if (segment === '..') {
      throw new WorkspacePathError('Path is outside workspace');
    }
    normalized.push(segment);
  }

  return normalized.join('/');
};

const realpathOrResolved = async (targetPath, fsPromises, pathModule) => {
  try {
    return await fsPromises.realpath(targetPath);
  } catch {
    return pathModule.resolve(targetPath);
  }
};

const findNearestExistingParent = async (absolutePath, rootPath, fsPromises, pathModule) => {
  let current = absolutePath;
  while (isPathWithinRoot(current, rootPath, pathModule)) {
    try {
      const stat = await fsPromises.stat(current);
      if (stat.isDirectory()) {
        return current;
      }
      return pathModule.dirname(current);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
      const parent = pathModule.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return rootPath;
};

const assertRealPathInsideRoot = async (candidatePath, rootRealPath, fsPromises, pathModule) => {
  const candidateRealPath = await fsPromises.realpath(candidatePath);
  if (!isPathWithinRoot(candidateRealPath, rootRealPath, pathModule)) {
    throw new WorkspacePathError('Path is outside workspace', 403);
  }
  return candidateRealPath;
};

export const resolveWorkspacePath = async (relativePathValue, options) => {
  const {
    root,
    fsPromises = fs.promises,
    pathModule = path,
    allowMissing = false,
  } = options || {};

  if (!root || typeof root !== 'string') {
    throw new WorkspacePathError('Workspace root is not configured', 500);
  }

  const rootPath = pathModule.resolve(root);
  const rootRealPath = await realpathOrResolved(rootPath, fsPromises, pathModule);
  if (!isPathWithinRoot(rootRealPath, rootPath, pathModule) && !isPathWithinRoot(rootPath, rootRealPath, pathModule)) {
    throw new WorkspacePathError('Workspace root could not be resolved', 500);
  }

  const relativePath = normalizeWorkspaceRelativePath(relativePathValue);
  const absolutePath = relativePath
    ? pathModule.resolve(rootPath, ...relativePath.split('/'))
    : rootPath;

  if (!isPathWithinRoot(absolutePath, rootPath, pathModule)) {
    throw new WorkspacePathError('Path is outside workspace', 403);
  }

  try {
    const realPath = await assertRealPathInsideRoot(absolutePath, rootRealPath, fsPromises, pathModule);
    return { rootPath, rootRealPath, relativePath, absolutePath, realPath };
  } catch (error) {
    if (!allowMissing || error?.code !== 'ENOENT') {
      throw error;
    }
  }

  const nearestParent = await findNearestExistingParent(absolutePath, rootPath, fsPromises, pathModule);
  await assertRealPathInsideRoot(nearestParent, rootRealPath, fsPromises, pathModule);

  return {
    rootPath,
    rootRealPath,
    relativePath,
    absolutePath,
    realPath: absolutePath,
  };
};

export const assertAbsolutePathInWorkspace = async (absolutePathValue, options) => {
  const {
    root,
    fsPromises = fs.promises,
    pathModule = path,
    allowMissing = false,
  } = options || {};

  if (typeof absolutePathValue !== 'string' || absolutePathValue.trim().length === 0) {
    throw new WorkspacePathError('Path is required');
  }

  const rootPath = pathModule.resolve(root);
  const absolutePath = pathModule.resolve(absolutePathValue);
  if (!isPathWithinRoot(absolutePath, rootPath, pathModule)) {
    throw new WorkspacePathError('Path is outside workspace', 403);
  }

  const relative = pathModule.relative(rootPath, absolutePath).replace(/\\/g, '/');
  return resolveWorkspacePath(relative, { root, fsPromises, pathModule, allowMissing });
};
