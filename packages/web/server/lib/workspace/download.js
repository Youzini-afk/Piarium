import fs from 'fs';
import path from 'path';
import { ZipFile } from 'yazl';

import { WorkspacePathError, resolveWorkspacePath } from './path-safety.js';
import { WorkspacePayloadTooLargeError } from './filesystem.js';

const safeDownloadName = (nameValue) => {
  const cleaned = String(nameValue || 'workspace')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim();
  return cleaned || 'workspace';
};

const toZipPath = (...segments) => (
  segments
    .filter((segment) => typeof segment === 'string' && segment.length > 0)
    .join('/')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
);

const getLimits = (config) => ({
  maxBytes: Number.isFinite(config.maxDownloadBytes) ? config.maxDownloadBytes : 12 * 1024 * 1024 * 1024,
  maxFiles: Number.isFinite(config.maxDownloadFiles) ? config.maxDownloadFiles : 0,
});

const assertWithinLimits = (totals, limits) => {
  if (limits.maxFiles > 0 && totals.files > limits.maxFiles) {
    throw new WorkspacePayloadTooLargeError('Directory contains too many files to download');
  }
  if (totals.bytes > limits.maxBytes) {
    throw new WorkspacePayloadTooLargeError('Directory is too large to download');
  }
};

const getDownloadInfoFromResolvedPath = (resolved, stat, pathModule) => {
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

const resolveDownloadInfo = async (pathValue, config, dependencies = {}) => {
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

const createDirectoryZipStream = async (download, config, dependencies = {}) => {
  const {
    fsPromises = fs.promises,
    pathModule = path,
  } = dependencies;
  const limits = getLimits(config);
  const totals = {
    files: 0,
    bytes: 0,
  };
  const directories = [];
  const files = [];

  const collectDirectory = async (absolutePath, zipPath) => {
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
    stream: zipFile.outputStream,
    totals,
  };
};

export const getWorkspaceDownloadInfo = async (pathValue, config, dependencies = {}) => {
  const { download } = await resolveDownloadInfo(pathValue, config, dependencies);
  return {
    type: download.type,
    fileName: download.fileName,
  };
};

export const resolveWorkspaceDownload = async (pathValue, config, dependencies = {}) => {
  const { download } = await resolveDownloadInfo(pathValue, config, dependencies);

  if (download.type === 'file') {
    return download;
  }

  return createDirectoryZipStream(download, config, dependencies);
};
