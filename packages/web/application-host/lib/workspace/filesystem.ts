import fs from 'fs';
import path from 'path';
import { ensureWorkspaceRoot } from './workspace-config.js';
import { WorkspacePathError, normalizeWorkspaceRelativePath, resolveWorkspacePath } from './path-safety.js';

export interface WorkspaceConfig {
  root: string;
  lockdown: boolean;
  trashEnabled: boolean;
  maxReadBytes: number;
  maxUploadBytes: number;
  maxDownloadBytes: number;
  maxDownloadFiles: number;
  maxArchiveBytes: number;
  maxExtractBytes: number;
  maxExtractFiles: number;
  archivePreviewLimit: number;
  customCommandsEnabled: boolean;
}

export interface ResolvedWorkspacePath {
  rootPath: string;
  rootRealPath: string;
  relativePath: string;
  absolutePath: string;
  realPath: string;
}

export interface GitSummary {
  branch: string | null;
  remote: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  relativePath: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  modifiedAt: string;
  mtimeMs: number;
  isProject?: true | undefined;
  git?: GitSummary | undefined;
}

export interface WorkspaceDependencies {
  fsPromises?: typeof fs.promises | undefined;
  pathModule?: typeof path | undefined;
}

export interface CreateWorkspaceEntryContext {
  rootPath: string;
  fsPromises?: typeof fs.promises | undefined;
  pathModule?: typeof path | undefined;
}

export interface CreateWorkspaceEntryOptions {
  rootListing?: boolean | undefined;
  includeGit?: boolean | undefined;
}

export interface CreateWorkspaceFileDependencies extends WorkspaceDependencies {
  content?: string | undefined;
}

export interface DeleteWorkspaceEntryDependencies extends WorkspaceDependencies {
  permanent?: boolean | undefined;
}

export interface UploadBuffer {
  name?: string | undefined;
  buffer: Buffer;
}

export interface UploadFile {
  name?: string | undefined;
  contentBase64?: string | undefined;
}

export interface MultipartUploadFile {
  originalname?: string | undefined;
  name?: string | undefined;
  buffer?: Buffer | undefined;
}

export interface WorkspaceRootInfo {
  root: string;
  relativeRoot: string;
  exists: boolean;
  mtimeMs: number;
  limits: {
    maxReadBytes: number;
    maxUploadBytes: number;
    maxDownloadBytes: number;
    maxDownloadFiles: number;
    maxArchiveBytes: number;
    maxExtractBytes: number;
    maxExtractFiles: number;
    archivePreviewLimit: number;
  };
  features: {
    lockdown: boolean;
    trash: boolean;
    customCommands: boolean;
  };
  separator: string;
}

export interface WorkspaceDirectoryListing {
  path: string;
  relativePath: string;
  entries: WorkspaceEntry[];
}

export interface WorkspaceMutationResult {
  success: true;
  entry: WorkspaceEntry;
}

export interface WorkspaceDeleteResult {
  success: true;
  trashed: boolean;
  trashPath?: string | undefined;
}

export interface WorkspaceUploadResult {
  success: true;
  entries: WorkspaceEntry[];
}

export class WorkspaceConflictError extends Error {
  statusCode: number;
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceConflictError';
    this.statusCode = 409;
  }
}

export class WorkspacePayloadTooLargeError extends Error {
  statusCode: number;
  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePayloadTooLargeError';
    this.statusCode = 413;
  }
}

const toIsoString = (value: number | Date): string => new Date(value).toISOString();

const toRelativePath = (
  rootPath: string,
  absolutePath: string,
  pathModule: typeof path,
): string => (
  pathModule.relative(rootPath, absolutePath).replace(/\\/g, '/')
);

const safeTrashName = (name: string): string => {
  const cleaned = String(name || 'entry').replace(/[\\/]/g, '-').trim();
  return cleaned || 'entry';
};

async function readGitSummary(absolutePath: string): Promise<GitSummary | null> {
  try {
    const git = await import('../git/index.js');
    if (!await git.isGitRepository(absolutePath)) {
      return null;
    }
    const status = await git.getStatus(absolutePath, { mode: 'light' });
    return {
      branch: status?.current || null,
      remote: status?.tracking || null,
      dirty: Array.isArray(status?.files) ? status.files.length > 0 : !status?.isClean,
      ahead: Number.isFinite(status?.ahead) ? status.ahead : 0,
      behind: Number.isFinite(status?.behind) ? status.behind : 0,
    };
  } catch {
    return null;
  }
}

export const createWorkspaceEntry = async (
  absolutePath: string,
  context: CreateWorkspaceEntryContext,
  options: CreateWorkspaceEntryOptions = {},
): Promise<WorkspaceEntry> => {
  const {
    rootPath,
    fsPromises = fs.promises,
    pathModule = path,
  } = context;
  const {
    rootListing = false,
    includeGit = true,
  } = options;

  const lstat = await fsPromises.lstat(absolutePath);
  const name = pathModule.basename(absolutePath);
  const isDirectory = lstat.isDirectory();
  const isSymlink = lstat.isSymbolicLink();
  const type: WorkspaceEntry['type'] = isSymlink ? 'symlink' : (isDirectory ? 'directory' : 'file');
  const relativePath = toRelativePath(rootPath, absolutePath, pathModule);
  const isProject = rootListing && isDirectory && name !== '.trash';
  const git = includeGit && isProject ? await readGitSummary(absolutePath) : null;

  return {
    name,
    path: absolutePath,
    relativePath,
    type,
    size: lstat.size,
    modifiedAt: toIsoString(lstat.mtimeMs),
    mtimeMs: lstat.mtimeMs,
    ...(isProject ? { isProject: true as const } : {}),
    ...(git ? { git } : {}),
  };
};

export const getWorkspaceRootInfo = async (
  config: WorkspaceConfig,
  dependencies: WorkspaceDependencies = {},
): Promise<WorkspaceRootInfo> => {
  const {
    fsPromises = fs.promises,
    pathModule = path,
  } = dependencies;
  await ensureWorkspaceRoot(config, fsPromises);
  const stat = await fsPromises.stat(config.root);

  return {
    root: config.root,
    relativeRoot: '',
    exists: true,
    mtimeMs: stat.mtimeMs,
    limits: {
      maxReadBytes: config.maxReadBytes,
      maxUploadBytes: config.maxUploadBytes,
      maxDownloadBytes: config.maxDownloadBytes,
      maxDownloadFiles: config.maxDownloadFiles,
      maxArchiveBytes: config.maxArchiveBytes,
      maxExtractBytes: config.maxExtractBytes,
      maxExtractFiles: config.maxExtractFiles,
      archivePreviewLimit: config.archivePreviewLimit,
    },
    features: {
      lockdown: config.lockdown,
      trash: config.trashEnabled,
      customCommands: config.customCommandsEnabled,
    },
    separator: pathModule.sep,
  };
};

export const listWorkspaceDirectory = async (
  relativePathValue: string,
  config: WorkspaceConfig,
  dependencies: WorkspaceDependencies = {},
): Promise<WorkspaceDirectoryListing> => {
  const {
    fsPromises = fs.promises,
    pathModule = path,
  } = dependencies;
  await ensureWorkspaceRoot(config, fsPromises);
  const requestedPath = normalizeWorkspaceRelativePath(relativePathValue);
  if (requestedPath === '.trash' && config.trashEnabled) {
    await fsPromises.mkdir(pathModule.join(config.root, '.trash'), { recursive: true });
  }
  const resolved = await resolveWorkspacePath(requestedPath, {
    root: config.root,
    fsPromises,
    pathModule,
  }) as ResolvedWorkspacePath;
  const stat = await fsPromises.stat(resolved.absolutePath);
  if (!stat.isDirectory()) {
    throw new WorkspacePathError('Path is not a directory', 400);
  }

  const dirents = await fsPromises.readdir(resolved.absolutePath, { withFileTypes: true });
  const rootListing = resolved.relativePath === '';
  const entries: WorkspaceEntry[] = [];
  for (const dirent of dirents) {
    if (rootListing && dirent.name === '.trash') {
      continue;
    }
    entries.push(await createWorkspaceEntry(pathModule.join(resolved.absolutePath, dirent.name), {
      rootPath: resolved.rootPath,
      fsPromises,
      pathModule,
    }, { rootListing }));
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) {
      if (a.type === 'directory') return -1;
      if (b.type === 'directory') return 1;
    }
    return a.name.localeCompare(b.name);
  });

  return {
    path: resolved.absolutePath,
    relativePath: resolved.relativePath,
    entries,
  };
};

export const getWorkspaceEntry = async (
  relativePathValue: string,
  config: WorkspaceConfig,
  dependencies: WorkspaceDependencies = {},
): Promise<WorkspaceEntry> => {
  const {
    fsPromises = fs.promises,
    pathModule = path,
  } = dependencies;
  await ensureWorkspaceRoot(config, fsPromises);
  const resolved = await resolveWorkspacePath(relativePathValue, {
    root: config.root,
    fsPromises,
    pathModule,
  }) as ResolvedWorkspacePath;
  return createWorkspaceEntry(resolved.absolutePath, {
    rootPath: resolved.rootPath,
    fsPromises,
    pathModule,
  });
};

export const createWorkspaceFolder = async (
  relativePathValue: string,
  config: WorkspaceConfig,
  dependencies: WorkspaceDependencies = {},
): Promise<WorkspaceMutationResult> => {
  const {
    fsPromises = fs.promises,
    pathModule = path,
  } = dependencies;
  await ensureWorkspaceRoot(config, fsPromises);
  const resolved = await resolveWorkspacePath(relativePathValue, {
    root: config.root,
    fsPromises,
    pathModule,
    allowMissing: true,
  }) as ResolvedWorkspacePath;
  if (!resolved.relativePath) {
    throw new WorkspacePathError('Cannot create the workspace root');
  }
  await fsPromises.mkdir(resolved.absolutePath, { recursive: true });
  return {
    success: true,
    entry: await createWorkspaceEntry(resolved.absolutePath, {
      rootPath: resolved.rootPath,
      fsPromises,
      pathModule,
    }),
  };
};

export const createWorkspaceFile = async (
  relativePathValue: string,
  config: WorkspaceConfig,
  dependencies: CreateWorkspaceFileDependencies = {},
): Promise<WorkspaceMutationResult> => {
  const {
    content = '',
    fsPromises = fs.promises,
    pathModule = path,
  } = dependencies;
  await ensureWorkspaceRoot(config, fsPromises);
  const resolved = await resolveWorkspacePath(relativePathValue, {
    root: config.root,
    fsPromises,
    pathModule,
    allowMissing: true,
  }) as ResolvedWorkspacePath;
  if (!resolved.relativePath) {
    throw new WorkspacePathError('Cannot create the workspace root as a file');
  }
  await fsPromises.mkdir(pathModule.dirname(resolved.absolutePath), { recursive: true });
  await fsPromises.writeFile(resolved.absolutePath, String(content ?? ''), { flag: 'wx' });
  return {
    success: true,
    entry: await createWorkspaceEntry(resolved.absolutePath, {
      rootPath: resolved.rootPath,
      fsPromises,
      pathModule,
    }),
  };
};

export const moveWorkspaceEntry = async (
  fromValue: string,
  toValue: string,
  config: WorkspaceConfig,
  dependencies: WorkspaceDependencies = {},
): Promise<WorkspaceMutationResult> => {
  const {
    fsPromises = fs.promises,
    pathModule = path,
  } = dependencies;
  await ensureWorkspaceRoot(config, fsPromises);
  const from = await resolveWorkspacePath(fromValue, {
    root: config.root,
    fsPromises,
    pathModule,
  }) as ResolvedWorkspacePath;
  const to = await resolveWorkspacePath(toValue, {
    root: config.root,
    fsPromises,
    pathModule,
    allowMissing: true,
  }) as ResolvedWorkspacePath;
  if (!from.relativePath || !to.relativePath) {
    throw new WorkspacePathError('Cannot move the workspace root');
  }
  const destinationExists = await fsPromises.lstat(to.absolutePath).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  if (destinationExists) {
    throw new WorkspaceConflictError('Destination already exists');
  }
  await fsPromises.mkdir(pathModule.dirname(to.absolutePath), { recursive: true });
  await fsPromises.rename(from.absolutePath, to.absolutePath);
  return {
    success: true,
    entry: await createWorkspaceEntry(to.absolutePath, {
      rootPath: to.rootPath,
      fsPromises,
      pathModule,
    }),
  };
};

export const deleteWorkspaceEntry = async (
  relativePathValue: string,
  config: WorkspaceConfig,
  dependencies: DeleteWorkspaceEntryDependencies = {},
): Promise<WorkspaceDeleteResult> => {
  const {
    permanent = false,
    fsPromises = fs.promises,
    pathModule = path,
  } = dependencies;
  await ensureWorkspaceRoot(config, fsPromises);
  const resolved = await resolveWorkspacePath(relativePathValue, {
    root: config.root,
    fsPromises,
    pathModule,
  }) as ResolvedWorkspacePath;
  if (!resolved.relativePath) {
    throw new WorkspacePathError('Cannot delete the workspace root');
  }

  if (permanent || !config.trashEnabled) {
    await fsPromises.rm(resolved.absolutePath, { recursive: true, force: true });
    return { success: true, trashed: false };
  }

  const trashDir = pathModule.join(resolved.rootPath, '.trash');
  await fsPromises.mkdir(trashDir, { recursive: true });
  const baseName = safeTrashName(pathModule.basename(resolved.absolutePath));
  const trashPath = pathModule.join(trashDir, `${Date.now()}-${baseName}`);
  await fsPromises.rename(resolved.absolutePath, trashPath);
  return {
    success: true,
    trashed: true,
    trashPath,
  };
};

const normalizeUploadName = (nameValue: string): string => {
  const name = normalizeWorkspaceRelativePath(nameValue || '');
  if (!name || name.includes('/')) {
    throw new WorkspacePathError('Uploaded file names must be simple relative file names');
  }
  return name;
};

const uploadWorkspaceBuffers = async (
  targetPathValue: string,
  files: UploadBuffer[],
  config: WorkspaceConfig,
  dependencies: WorkspaceDependencies = {},
): Promise<WorkspaceUploadResult> => {
  const {
    fsPromises = fs.promises,
    pathModule = path,
  } = dependencies;
  if (!Array.isArray(files) || files.length === 0) {
    throw new WorkspacePathError('No files provided');
  }
  await ensureWorkspaceRoot(config, fsPromises);
  const targetDir = await resolveWorkspacePath(targetPathValue, {
    root: config.root,
    fsPromises,
    pathModule,
    allowMissing: true,
  }) as ResolvedWorkspacePath;
  await fsPromises.mkdir(targetDir.absolutePath, { recursive: true });

  let totalBytes = 0;
  const uploaded: WorkspaceEntry[] = [];
  for (const file of files) {
    const name = normalizeUploadName(file?.name ?? '');
    const buffer = Buffer.isBuffer(file?.buffer) ? file.buffer : Buffer.from(file?.buffer || []);
    totalBytes += buffer.length;
    if (totalBytes > config.maxUploadBytes) {
      throw new WorkspacePayloadTooLargeError('Upload is too large');
    }
    const target = await resolveWorkspacePath(targetDir.relativePath ? `${targetDir.relativePath}/${name}` : name, {
      root: config.root,
      fsPromises,
      pathModule,
      allowMissing: true,
    }) as ResolvedWorkspacePath;
    await fsPromises.writeFile(target.absolutePath, buffer);
    uploaded.push(await createWorkspaceEntry(target.absolutePath, {
      rootPath: target.rootPath,
      fsPromises,
      pathModule,
    }));
  }

  return { success: true, entries: uploaded };
};

export const uploadWorkspaceFiles = async (
  targetPathValue: string,
  files: UploadFile[],
  config: WorkspaceConfig,
  dependencies: WorkspaceDependencies = {},
): Promise<WorkspaceUploadResult> => {
  if (!Array.isArray(files) || files.length === 0) {
    throw new WorkspacePathError('No files provided');
  }
  const buffers = files.map((file) => {
    const contentBase64 = typeof file?.contentBase64 === 'string' ? file.contentBase64 : '';
    return {
      name: file?.name,
      buffer: Buffer.from(contentBase64, 'base64'),
    };
  });
  return uploadWorkspaceBuffers(targetPathValue, buffers, config, dependencies);
};

export const uploadWorkspaceMultipartFiles = async (
  targetPathValue: string,
  files: MultipartUploadFile[],
  config: WorkspaceConfig,
  dependencies: WorkspaceDependencies = {},
): Promise<WorkspaceUploadResult> => {
  if (!Array.isArray(files) || files.length === 0) {
    throw new WorkspacePathError('No files provided');
  }
  const buffers = files.map((file) => ({
    name: file?.originalname || file?.name,
    buffer: file?.buffer ?? Buffer.from([]),
  }));
  return uploadWorkspaceBuffers(targetPathValue, buffers as UploadBuffer[], config, dependencies);
};
