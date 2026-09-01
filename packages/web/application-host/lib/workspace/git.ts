import fs from 'fs';
import path from 'path';
import type { WorkspaceConfig } from './workspace-config.js';
import { ensureWorkspaceRoot } from './workspace-config.js';
import { resolveWorkspacePath } from './path-safety.js';

type PathModule = typeof import('path');
type FsPromises = typeof fs.promises;
type GitLibraries = typeof import('../git/index.js');

export interface GitDependencies {
  fsPromises?: FsPromises | undefined;
  pathModule?: PathModule | undefined;
  options?: Record<string, unknown> | undefined;
}

interface GitFetchPayload {
  [key: string]: unknown;
}

interface GitClonePayload {
  url?: unknown;
  branch?: unknown;
  directoryName?: unknown;
}

interface GitCommitPayload {
  message?: unknown;
  addAll?: unknown;
  files?: unknown;
}

interface GitCommitOptions {
  addAll: boolean;
  files?: unknown[] | undefined;
}

interface GitStatusResult {
  isGitRepository: boolean;
  files?: unknown[];
  branch?: string | null | undefined;
  current?: string | undefined;
  tracking?: string | null | undefined;
  ahead?: number | undefined;
  behind?: number | undefined;
  isClean?: boolean | undefined;
  [key: string]: unknown;
}

interface HttpError extends Error {
  statusCode: number;
}

const resolveWorkspaceGitDirectory = async (
  relativePathValue: unknown,
  config: WorkspaceConfig,
  dependencies: GitDependencies = {},
): Promise<string> => {
  const {
    fsPromises = fs.promises,
    pathModule = path,
  } = dependencies;
  await ensureWorkspaceRoot(config, fsPromises);
  const resolved = await resolveWorkspacePath(relativePathValue, {
    root: config.root,
    fsPromises,
    pathModule,
  });
  const stat = await fsPromises.stat(resolved.absolutePath);
  if (!stat.isDirectory()) {
    const error = new Error('Git operations require a workspace directory') as HttpError;
    error.statusCode = 400;
    throw error;
  }
  return resolved.absolutePath;
};

const getGitLibraries = async (): Promise<GitLibraries> => import('../git/index.js');

const createBadRequest = (message: string): HttpError => {
  const error = new Error(message) as HttpError;
  error.statusCode = 400;
  return error;
};

const hasControlCharacters = (value: string): boolean => /[\0\r\n]/.test(value);

const assertSafeGitArgument = (value: unknown, label: string): string => {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (hasControlCharacters(text)) {
    throw createBadRequest(`${label} contains invalid characters`);
  }
  if (text.startsWith('-')) {
    throw createBadRequest(`${label} cannot start with '-'`);
  }
  return text;
};

const assertSafeCloneDirectoryName = (value: unknown): string => {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (
    text === '.'
    || text === '..'
    || text.includes('/')
    || text.includes('\\')
    || hasControlCharacters(text)
    || text.startsWith('-')
  ) {
    throw createBadRequest('destination folder must be a simple folder name');
  }
  return text;
};

export const getWorkspaceGitStatus = async (
  relativePathValue: unknown,
  config: WorkspaceConfig,
  dependencies: GitDependencies = {},
): Promise<GitStatusResult> => {
  const directory = await resolveWorkspaceGitDirectory(relativePathValue, config, dependencies);
  const git = await getGitLibraries();
  if (!await git.isGitRepository(directory)) {
    return {
      isGitRepository: false,
      files: [],
      branch: null,
      current: '',
      tracking: null,
      ahead: 0,
      behind: 0,
      isClean: true,
    };
  }
  return {
    isGitRepository: true,
    ...await git.getStatus(directory, dependencies.options || {}),
  };
};

export const workspaceGitFetch = async (
  relativePathValue: unknown,
  payload: GitFetchPayload | null | undefined,
  config: WorkspaceConfig,
  dependencies: GitDependencies = {},
): Promise<unknown> => {
  const directory = await resolveWorkspaceGitDirectory(relativePathValue, config, dependencies);
  const git = await getGitLibraries();
  return git.fetch(directory, payload || {});
};

export const workspaceGitClone = async (
  relativePathValue: unknown,
  payload: GitClonePayload | null | undefined,
  config: WorkspaceConfig,
  dependencies: GitDependencies = {},
): Promise<unknown> => {
  const directory = await resolveWorkspaceGitDirectory(relativePathValue, config, dependencies);
  const git = await getGitLibraries();
  const url = assertSafeGitArgument(payload?.url, 'repository url');
  if (!url) {
    throw createBadRequest('repository url is required');
  }
  if (/^ext::/i.test(url)) {
    throw createBadRequest('ext:: git remotes are not supported from the workspace UI');
  }
  const branch = assertSafeGitArgument(payload?.branch, 'branch');
  const directoryName = assertSafeCloneDirectoryName(payload?.directoryName);
  return git.cloneRepository(directory, {
    url,
    branch,
    directoryName,
  });
};

export const workspaceGitPull = async (
  relativePathValue: unknown,
  payload: GitFetchPayload | null | undefined,
  config: WorkspaceConfig,
  dependencies: GitDependencies = {},
): Promise<unknown> => {
  const directory = await resolveWorkspaceGitDirectory(relativePathValue, config, dependencies);
  const git = await getGitLibraries();
  return git.pull(directory, payload || {});
};

export const workspaceGitPush = async (
  relativePathValue: unknown,
  payload: GitFetchPayload | null | undefined,
  config: WorkspaceConfig,
  dependencies: GitDependencies = {},
): Promise<unknown> => {
  const directory = await resolveWorkspaceGitDirectory(relativePathValue, config, dependencies);
  const git = await getGitLibraries();
  return git.push(directory, payload || {});
};

export const workspaceGitCheckout = async (
  relativePathValue: unknown,
  branch: string,
  config: WorkspaceConfig,
  dependencies: GitDependencies = {},
): Promise<unknown> => {
  const directory = await resolveWorkspaceGitDirectory(relativePathValue, config, dependencies);
  const git = await getGitLibraries();
  return git.checkoutBranch(directory, branch);
};

export const workspaceGitCommit = async (
  relativePathValue: unknown,
  payload: GitCommitPayload | null | undefined,
  config: WorkspaceConfig,
  dependencies: GitDependencies = {},
): Promise<unknown> => {
  const directory = await resolveWorkspaceGitDirectory(relativePathValue, config, dependencies);
  const git = await getGitLibraries();
  const message = String(payload?.message || '').trim();
  if (!message) {
    const error = new Error('message is required') as HttpError;
    error.statusCode = 400;
    throw error;
  }
  const commitOptions: GitCommitOptions = {
    addAll: payload?.addAll === true,
    files: Array.isArray(payload?.files) ? payload.files as unknown[] : undefined,
  };
  return git.commit(directory, message, commitOptions);
};

export const workspaceGitLog = async (
  relativePathValue: unknown,
  query: Record<string, unknown> | null | undefined,
  config: WorkspaceConfig,
  dependencies: GitDependencies = {},
): Promise<unknown> => {
  const directory = await resolveWorkspaceGitDirectory(relativePathValue, config, dependencies);
  const git = await getGitLibraries();
  return git.getLog(directory, query || {});
};

export const workspaceGitRemotes = async (
  relativePathValue: unknown,
  config: WorkspaceConfig,
  dependencies: GitDependencies = {},
): Promise<unknown> => {
  const directory = await resolveWorkspaceGitDirectory(relativePathValue, config, dependencies);
  const git = await getGitLibraries();
  return git.getRemotes(directory);
};
