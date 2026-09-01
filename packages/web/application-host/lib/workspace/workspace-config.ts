import fs from 'fs';
import os from 'os';
import path from 'path';

type PathModule = typeof import('path');
type OsModule = typeof import('os');
type FsPromises = typeof fs.promises;

interface EnvLike {
  PIARIUM_WORKSPACE_ROOT?: string | undefined;
  PIARIUM_WORKSPACE_LOCKDOWN?: string | undefined;
  PIARIUM_WORKSPACE_TRASH?: string | undefined;
  PIARIUM_WORKSPACE_MAX_READ_MB?: string | undefined;
  PIARIUM_WORKSPACE_MAX_UPLOAD_MB?: string | undefined;
  PIARIUM_WORKSPACE_MAX_DOWNLOAD_MB?: string | undefined;
  PIARIUM_WORKSPACE_MAX_DOWNLOAD_FILES?: string | undefined;
  PIARIUM_WORKSPACE_MAX_ARCHIVE_MB?: string | undefined;
  PIARIUM_WORKSPACE_MAX_EXTRACT_MB?: string | undefined;
  PIARIUM_WORKSPACE_MAX_EXTRACT_FILES?: string | undefined;
  PIARIUM_WORKSPACE_ARCHIVE_PREVIEW_LIMIT?: string | undefined;
  PIARIUM_WORKSPACE_CUSTOM_COMMANDS?: string | undefined;
  ZEABUR?: string | undefined;
  DOCKER?: string | undefined;
  PIARIUM_RUNTIME?: string | undefined;
  [key: string]: string | undefined;
}

interface ResolveDefaultWorkspaceRootOptions {
  env?: EnvLike | undefined;
  cwd?: string | undefined;
  pathModule?: PathModule | undefined;
  osModule?: OsModule | undefined;
}

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

export interface CreateWorkspaceConfigOptions {
  env?: EnvLike | undefined;
  cwd?: string | undefined;
  pathModule?: PathModule | undefined;
  osModule?: OsModule | undefined;
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

const parseBoolean = (value: string | boolean | undefined, fallback: boolean): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return fallback;
};

const parseMegabytes = (value: string | undefined, fallbackMb: number): number => {
  const parsed = Number.parseFloat(String(value ?? '').trim());
  const mb = Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackMb;
  return Math.max(0, Math.round(mb * 1024 * 1024));
};

const parseNonNegativeInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const resolveDefaultWorkspaceRoot = ({
  env = process.env as EnvLike,
  cwd = process.cwd(),
  pathModule = path,
  osModule = os,
}: ResolveDefaultWorkspaceRootOptions = {}): string => {
  const explicit = typeof env.PIARIUM_WORKSPACE_ROOT === 'string'
    ? env.PIARIUM_WORKSPACE_ROOT.trim()
    : '';
  if (explicit) {
    return pathModule.resolve(explicit);
  }

  if (env.ZEABUR || env.DOCKER || env.PIARIUM_RUNTIME === 'web') {
    return pathModule.resolve('/workspace');
  }

  const cwdBase = typeof cwd === 'string' && cwd.length > 0 ? cwd : osModule.homedir();
  return pathModule.resolve(cwdBase, 'workspace');
};

export const createWorkspaceConfig = (options: CreateWorkspaceConfigOptions = {}): WorkspaceConfig => {
  const {
    env = process.env as EnvLike,
    cwd = process.cwd(),
    pathModule = path,
    osModule = os,
  } = options;

  const root = resolveDefaultWorkspaceRoot({ env, cwd, pathModule, osModule });
  const explicitRoot = typeof env.PIARIUM_WORKSPACE_ROOT === 'string' && env.PIARIUM_WORKSPACE_ROOT.trim().length > 0;
  const cloudDefault = explicitRoot || Boolean(env.ZEABUR || env.DOCKER);

  return {
    root,
    lockdown: parseBoolean(env.PIARIUM_WORKSPACE_LOCKDOWN, cloudDefault),
    trashEnabled: parseBoolean(env.PIARIUM_WORKSPACE_TRASH, true),
    maxReadBytes: parseMegabytes(env.PIARIUM_WORKSPACE_MAX_READ_MB, 2),
    maxUploadBytes: parseMegabytes(env.PIARIUM_WORKSPACE_MAX_UPLOAD_MB, 1024),
    maxDownloadBytes: parseMegabytes(env.PIARIUM_WORKSPACE_MAX_DOWNLOAD_MB, 12288),
    maxDownloadFiles: parseNonNegativeInteger(env.PIARIUM_WORKSPACE_MAX_DOWNLOAD_FILES, 0),
    maxArchiveBytes: parseMegabytes(env.PIARIUM_WORKSPACE_MAX_ARCHIVE_MB, 1024),
    maxExtractBytes: parseMegabytes(env.PIARIUM_WORKSPACE_MAX_EXTRACT_MB, 3072),
    maxExtractFiles: parseNonNegativeInteger(env.PIARIUM_WORKSPACE_MAX_EXTRACT_FILES, 30000),
    archivePreviewLimit: parseNonNegativeInteger(env.PIARIUM_WORKSPACE_ARCHIVE_PREVIEW_LIMIT, 500),
    customCommandsEnabled: parseBoolean(env.PIARIUM_WORKSPACE_CUSTOM_COMMANDS, false),
  };
};

export const ensureWorkspaceRoot = async (
  config: WorkspaceConfig,
  fsPromises: FsPromises = fs.promises,
): Promise<string> => {
  await fsPromises.mkdir(config.root, { recursive: true });
  return config.root;
};
