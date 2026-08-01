import fs from 'fs';
import os from 'os';
import path from 'path';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

const parseBoolean = (value, fallback) => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return fallback;
};

const parseMegabytes = (value, fallbackMb) => {
  const parsed = Number.parseFloat(String(value ?? '').trim());
  const mb = Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackMb;
  return Math.max(0, Math.round(mb * 1024 * 1024));
};

const parseNonNegativeInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const resolveDefaultWorkspaceRoot = ({ env = process.env, cwd = process.cwd(), pathModule = path, osModule = os } = {}) => {
  const explicit = typeof env.OPENCHAMBER_WORKSPACE_ROOT === 'string'
    ? env.OPENCHAMBER_WORKSPACE_ROOT.trim()
    : '';
  if (explicit) {
    return pathModule.resolve(explicit);
  }

  if (env.ZEABUR || env.DOCKER || env.OPENCHAMBER_RUNTIME === 'web') {
    return pathModule.resolve('/workspace');
  }

  const cwdBase = typeof cwd === 'string' && cwd.length > 0 ? cwd : osModule.homedir();
  return pathModule.resolve(cwdBase, 'workspace');
};

export const createWorkspaceConfig = (options = {}) => {
  const {
    env = process.env,
    cwd = process.cwd(),
    pathModule = path,
    osModule = os,
  } = options;

  const root = resolveDefaultWorkspaceRoot({ env, cwd, pathModule, osModule });
  const explicitRoot = typeof env.OPENCHAMBER_WORKSPACE_ROOT === 'string' && env.OPENCHAMBER_WORKSPACE_ROOT.trim().length > 0;
  const cloudDefault = explicitRoot || Boolean(env.ZEABUR || env.DOCKER);

  return {
    root,
    lockdown: parseBoolean(env.OPENCHAMBER_WORKSPACE_LOCKDOWN, cloudDefault),
    trashEnabled: parseBoolean(env.OPENCHAMBER_WORKSPACE_TRASH, true),
    maxReadBytes: parseMegabytes(env.OPENCHAMBER_WORKSPACE_MAX_READ_MB, 2),
    maxUploadBytes: parseMegabytes(env.OPENCHAMBER_WORKSPACE_MAX_UPLOAD_MB, 1024),
    maxDownloadBytes: parseMegabytes(env.OPENCHAMBER_WORKSPACE_MAX_DOWNLOAD_MB, 12288),
    maxDownloadFiles: parseNonNegativeInteger(env.OPENCHAMBER_WORKSPACE_MAX_DOWNLOAD_FILES, 0),
    maxArchiveBytes: parseMegabytes(env.OPENCHAMBER_WORKSPACE_MAX_ARCHIVE_MB, 1024),
    maxExtractBytes: parseMegabytes(env.OPENCHAMBER_WORKSPACE_MAX_EXTRACT_MB, 3072),
    maxExtractFiles: parseNonNegativeInteger(env.OPENCHAMBER_WORKSPACE_MAX_EXTRACT_FILES, 30000),
    archivePreviewLimit: parseNonNegativeInteger(env.OPENCHAMBER_WORKSPACE_ARCHIVE_PREVIEW_LIMIT, 500),
    customCommandsEnabled: parseBoolean(env.OPENCHAMBER_WORKSPACE_CUSTOM_COMMANDS, false),
  };
};

export const ensureWorkspaceRoot = async (config, fsPromises = fs.promises) => {
  await fsPromises.mkdir(config.root, { recursive: true });
  return config.root;
};
