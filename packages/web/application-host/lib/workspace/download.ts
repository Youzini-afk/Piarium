import fs from 'fs';
import path from 'path';
import { ZipFile } from 'yazl';
import type { Readable } from 'stream';

import { WorkspacePathError, resolveWorkspacePath } from './path-safety.js';
import type { ResolvedWorkspacePath } from './path-safety.js';
import { WorkspacePayloadTooLargeError } from './filesystem.js';
import type { WorkspaceConfig } from './workspace-config.js';

type PathModule = typeof import('path');
type FsPromises = typeof fs.promises;

export interface DownloadDependencies {
  fsPromises?: FsPromises | undefined;
  pathModule?: PathModule | undefined;
}

interface DownloadLimits {
  maxBytes: number;
  maxFiles: number;
}

interface DownloadTotals {
  files: number;
  bytes: number;
}

interface FileDownloadInfo {
  type: 'file';
  filePath: string;
  fileName: string;
}

interface ArchiveDownloadInfo {
  type: 'archive';
  directoryPath: string;
  baseName: string;
  fileName: string;
}

type DownloadInfo = FileDownloadInfo | ArchiveDownloadInfo;

interface ArchiveDownloadStream extends ArchiveDownloadInfo {
  stream: Readable;
  totals: DownloadTotals;
}

interface ResolvedDownloadInfo {
  resolved: ResolvedWorkspacePath;
  stat: fs.Stats;
  download: DownloadInfo;
}

interface DirectoryEntry {
  zipPath: string;
}

interface FileEntry {
  absolutePath: string;
  zipPath: string;
  mtime: Date;
  mode: number;
}

export interface WorkspaceDownloadInfo {
  type: 'file' | 'archive';
  fileName: string;
}

export type WorkspaceDownloadResult = FileDownloadInfo | ArchiveDownloadStream;

const safeDownloadName = (nameValue: unknown): string => {
  const cleaned = String(nameValue || 'workspace')
    // Control characters are intentionally replaced in download filenames.
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim();
  return cleaned || 'workspace';
};

const toZipPath = (...segments: unknown[]): string => (
  segments
    .filter((segment): segment is string => typeof segment === 'string' && segment.length > 0)
    .join('/')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
);

const getLimits = (config: WorkspaceConfig): DownloadLimits => ({
  maxBytes: Number.isFinite(config.maxDownloadBytes) ? config.maxDownloadBytes : 12 * 1024 * 1024 * 1024,
  maxFiles: Number.isFinite(config.maxDownloadFiles) ? config.maxDownloadFiles : 0,
});

const assertWithinLimits = (totals: DownloadTotals, limits: DownloadLimits): void => {
  if (limits.maxFiles > 0 && totals.files > limits.maxFiles) {
    throw new WorkspacePayloadTooLargeError('Directory contains too many files to download');
  }
  if (totals.bytes > limits.maxBytes) {
    throw new WorkspacePayloadTooLargeError('Directory is too large to download');
  }
};

const getDownloadInfoFromResolvedPath = (
  resolved: ResolvedWorkspacePath,
  stat: fs.Stats,
  pathModule: PathModule,
): DownloadInfo => {
  if (stat.isFile()) {
    return {
      type: 'file',
      filePath: resolved.absolutePath,
      fileName: pathModule.basename(resolved.absolutePath) || 'download',
    };
  }

  if (stat.isDirectory()) {
    const baseName = safeDownloadName(pathModule.basename(resolved.absolutePath) || 'workspace');
    return {
      type: 'archive',
      directoryPath: resolved.absolutePath,
      baseName,
      fileName: `${baseName}.zip`,
    };
  }

  throw new WorkspacePathError('Path is not a file or directory');
};

const resolveDownloadInfo = async (
  pathValue: unknown,
  config: WorkspaceConfig,
  dependencies: DownloadDependencies = {},
): Promise<ResolvedDownloadInfo> => {
  const {
    fsPromises = fs.promises,
    pathModule = path,
  } = dependencies;

  const resolved = await resolveWorkspacePath(pathValue, {
    root: config.root,
    fsPromises,
    pathModule,
  });
  const stat = await fsPromises.stat(resolved.absolutePath);
  return {
    resolved,
    stat,
    download: getDownloadInfoFromResolvedPath(resolved, stat, pathModule),
  };
};

const createDirectoryZipStream = async (
  download: ArchiveDownloadInfo,
  config: WorkspaceConfig,
  dependencies: DownloadDependencies = {},
): Promise<ArchiveDownloadStream> => {
  const {
    fsPromises = fs.promises,
    pathModule = path,
  } = dependencies;
  const limits = getLimits(config);
  const totals: DownloadTotals = {
    files: 0,
    bytes: 0,
  };
  const directories: DirectoryEntry[] = [];
  const files: FileEntry[] = [];

  const collectDirectory = async (absolutePath: string, zipPath: string): Promise<void> => {
    directories.push({ zipPath });

    const entries = await fsPromises.readdir(absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      const childAbsolutePath = pathModule.join(absolutePath, entry.name);
      const childZipPath = toZipPath(zipPath, entry.name);
      const childStat = await fsPromises.lstat(childAbsolutePath);

      if (childStat.isSymbolicLink()) {
        continue;
      }

      if (childStat.isDirectory()) {
        await collectDirectory(childAbsolutePath, childZipPath);
        continue;
      }

      if (!childStat.isFile()) {
        continue;
      }

      totals.files += 1;
      totals.bytes += childStat.size;
      assertWithinLimits(totals, limits);
      files.push({
        absolutePath: childAbsolutePath,
        zipPath: childZipPath,
        mtime: childStat.mtime,
        mode: childStat.mode,
      });
    }
  };

  await collectDirectory(download.directoryPath, download.baseName);

  const zipFile = new ZipFile();
  for (const directory of directories) {
    zipFile.addEmptyDirectory(directory.zipPath);
  }
  for (const file of files) {
    zipFile.addFile(file.absolutePath, file.zipPath, {
      mtime: file.mtime,
      mode: file.mode,
    });
  }
  zipFile.end();

  return {
    ...download,
    stream: zipFile.outputStream as Readable,
    totals,
  };
};

export const getWorkspaceDownloadInfo = async (
  pathValue: unknown,
  config: WorkspaceConfig,
  dependencies: DownloadDependencies = {},
): Promise<WorkspaceDownloadInfo> => {
  const { download } = await resolveDownloadInfo(pathValue, config, dependencies);
  return {
    type: download.type,
    fileName: download.fileName,
  };
};

export const resolveWorkspaceDownload = async (
  pathValue: unknown,
  config: WorkspaceConfig,
  dependencies: DownloadDependencies = {},
): Promise<WorkspaceDownloadResult> => {
  const { download } = await resolveDownloadInfo(pathValue, config, dependencies);

  if (download.type === 'file') {
    return download;
  }

  return createDirectoryZipStream(download, config, dependencies);
};
