import fs from 'fs';
import path from 'path';
import { ensureWorkspaceRoot } from './workspace-config.js';
import { resolveWorkspacePath } from './path-safety.js';

const resolveWorkspaceGitDirectory = async (relativePathValue, config, dependencies = {}) => {
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
    const error = new Error('Git operations require a workspace directory');
    error.statusCode = 400;
    throw error;
  }
  return resolved.absolutePath;
};

const getGitLibraries = async () => import('../git/index.js');

const createBadRequest = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
};

const hasControlCharacters = (value) => /[\0\r\n]/.test(value);

const assertSafeGitArgument = (value, label) => {
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

const assertSafeCloneDirectoryName = (value) => {
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

export const getWorkspaceGitStatus = async (relativePathValue, config, dependencies = {}) => {
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

export const workspaceGitFetch = async (relativePathValue, payload, config, dependencies = {}) => {
  const directory = await resolveWorkspaceGitDirectory(relativePathValue, config, dependencies);
  const git = await getGitLibraries();
  return git.fetch(directory, payload || {});
};

export const workspaceGitClone = async (relativePathValue, payload, config, dependencies = {}) => {
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

export const workspaceGitPull = async (relativePathValue, payload, config, dependencies = {}) => {
  const directory = await resolveWorkspaceGitDirectory(relativePathValue, config, dependencies);
  const git = await getGitLibraries();
  return git.pull(directory, payload || {});
};

export const workspaceGitPush = async (relativePathValue, payload, config, dependencies = {}) => {
  const directory = await resolveWorkspaceGitDirectory(relativePathValue, config, dependencies);
  const git = await getGitLibraries();
  return git.push(directory, payload || {});
};

export const workspaceGitCheckout = async (relativePathValue, branch, config, dependencies = {}) => {
  const directory = await resolveWorkspaceGitDirectory(relativePathValue, config, dependencies);
  const git = await getGitLibraries();
  return git.checkoutBranch(directory, branch);
};

export const workspaceGitCommit = async (relativePathValue, payload, config, dependencies = {}) => {
  const directory = await resolveWorkspaceGitDirectory(relativePathValue, config, dependencies);
  const git = await getGitLibraries();
  const message = String(payload?.message || '').trim();
  if (!message) {
    const error = new Error('message is required');
    error.statusCode = 400;
    throw error;
  }
  return git.commit(directory, message, {
    addAll: payload?.addAll === true,
    files: Array.isArray(payload?.files) ? payload.files : undefined,
  });
};

export const workspaceGitLog = async (relativePathValue, query, config, dependencies = {}) => {
  const directory = await resolveWorkspaceGitDirectory(relativePathValue, config, dependencies);
  const git = await getGitLibraries();
  return git.getLog(directory, query || {});
};

export const workspaceGitRemotes = async (relativePathValue, config, dependencies = {}) => {
  const directory = await resolveWorkspaceGitDirectory(relativePathValue, config, dependencies);
  const git = await getGitLibraries();
  return git.getRemotes(directory);
};
