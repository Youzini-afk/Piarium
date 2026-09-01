import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { extract as tarExtract, list as tarList } from 'tar';

import { ensureWorkspaceRoot } from './workspace-config.js';
import { WorkspacePathError, normalizeWorkspaceRelativePath, resolveWorkspacePath, isPathWithinRoot } from './path-safety.js';
import { WorkspaceConflictError, WorkspacePayloadTooLargeError, createWorkspaceEntry } from './filesystem.js';
import type {
  WorkspaceConfig,
  WorkspaceDependencies,
  WorkspaceEntry,
  ResolvedWorkspacePath,
} from './filesystem.js';

// ── Types ─────────────────────────────────────────────────────────────────

type ArchiveFormat = 'tgz' | 'tar' | 'zip';
type ArchiveEntryType = 'file' | 'directory';
type ArchiveConflictMode = 'rename' | 'skip' | 'error';
type ArchiveExtractMode = 'merge' | 'new-folder';

interface ArchiveEntry {
  path: string;
  rawPath: string;
  type: ArchiveEntryType;
  size: number;
}

interface ZipArchiveEntry extends ArchiveEntry {
  zipEntry: AdmZip.IZipEntry;
}

interface ArchivePreviewEntry {
  path: string;
  type: ArchiveEntryType;
  size: number;
}

interface ArchiveAnalysis {
  entries: ArchiveEntry[];
  previewEntries: ArchivePreviewEntry[];
  totalFiles: number;
  totalDirectories: number;
  totalBytes: number;
  truncated: boolean;
}

interface ReadZipResult {
  entries: ZipArchiveEntry[];
  zip: AdmZip;
}

interface ReadTarResult {
  entries: ArchiveEntry[];
}

interface ResolveArchiveResult {
  resolved: ResolvedWorkspacePath;
  format: ArchiveFormat;
}

interface ArchivePreviewResult {
  archive: WorkspaceEntry;
  format: ArchiveFormat;
  entries: ArchivePreviewEntry[];
  totalFiles: number;
  totalDirectories: number;
  totalBytes: number;
  truncated: boolean;
}

interface ExtractPayload {
  path?: string | undefined;
  conflict?: string | undefined;
  mode?: string | undefined;
  destination?: string | undefined;
  deleteArchive?: boolean | undefined;
}

interface ResolveArchiveDestinationResult {
  mode: ArchiveExtractMode;
  destination: ResolvedWorkspacePath;
}

interface ExtractStats {
  filesCreated: number;
  directoriesCreated: number;
  bytesWritten: number;
  conflictsRenamed: number;
  conflictsSkipped: number;
}

interface ExtractResult {
  success: true;
  destination: string;
  destinationEntry: WorkspaceEntry;
  filesCreated: number;
  directoriesCreated: number;
  bytesWritten: number;
  conflictsRenamed: number;
  conflictsSkipped: number;
  deletedArchive: boolean;
}

interface ArchiveDependencies extends WorkspaceDependencies {}

// ── Constants ─────────────────────────────────────────────────────────────

const ZIP_SYMLINK_MODE = 0o120000;
const ZIP_FILE_TYPE_MASK = 0o170000;
const TAR_FILE_TYPES = new Set<string>(['File', 'OldFile', 'ContiguousFile']);
const TAR_DIRECTORY_TYPES = new Set<string>(['Directory', 'GNUDumpDir']);
const DEFAULT_CONFLICT: ArchiveConflictMode = 'rename';
const utf8FilenameDecoder = new TextDecoder('utf-8', { fatal: true });
const lenientUtf8FilenameDecoder = new TextDecoder('utf-8');
const gbkFilenameDecoder = new TextDecoder('gbk');

// ── Helpers ───────────────────────────────────────────────────────────────

const containsCjkCharacter = (value: string): boolean => /[\u3400-\u9fff\uf900-\ufaff]/u.test(String(value || ''));

const decodeZipFilename = (data: Buffer | Uint8Array, allowGbkFallback = true): string => {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  try {
    return utf8FilenameDecoder.decode(buffer);
  } catch {
    if (!allowGbkFallback) {
      throw makeWorkspaceError('ZIP entry filename is not valid UTF-8', 415);
    }
    const gbk = gbkFilenameDecoder.decode(buffer);
    return containsCjkCharacter(gbk) ? gbk : lenientUtf8FilenameDecoder.decode(buffer);
  }
};

const zipFilenameDecoder = {
  efs: true,
  encode: (value: string): Buffer => Buffer.from(String(value || ''), 'utf8'),
  decode: decodeZipFilename,
};

export const detectArchiveFormat = (pathValue: string): ArchiveFormat | null => {
  const lower = String(pathValue || '').toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tgz';
  if (lower.endsWith('.tar')) return 'tar';
  if (lower.endsWith('.zip')) return 'zip';
  return null;
};

const stripArchiveExtension = (name: string): string => {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz')) return name.slice(0, -7);
  if (lower.endsWith('.tgz')) return name.slice(0, -4);
  if (lower.endsWith('.tar')) return name.slice(0, -4);
  if (lower.endsWith('.zip')) return name.slice(0, -4);
  return name;
};

const parentPathOf = (relativePath: string): string => {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  if (!normalized) return '';
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index) : '';
};

const childPath = (parent: string, name: string): string => {
  const safeParent = normalizeWorkspaceRelativePath(parent);
  const safeName = normalizeWorkspaceRelativePath(name);
  return safeParent ? `${safeParent}/${safeName}` : safeName;
};

const makeWorkspaceError = (message: string, statusCode = 400): WorkspacePathError => new WorkspacePathError(message, statusCode);

export const sanitizeArchiveEntryPath = (entryPath: string): string => {
  const raw = String(entryPath || '');
  if (!raw || raw === '.' || raw === './') {
    throw makeWorkspaceError('Archive entry path is empty');
  }
  const normalized = normalizeWorkspaceRelativePath(raw);
  if (!normalized) {
    throw makeWorkspaceError('Archive entry path is empty');
  }
  return normalized;
};

const normalizeEntryType = (inputType: string): ArchiveEntryType => {
  if (inputType === 'directory') return 'directory';
  if (inputType === 'file') return 'file';
  throw makeWorkspaceError('Archive contains unsupported entry type', 415);
};

const createArchiveEntry = (rawPath: string, type: string, size: number = 0): ArchiveEntry => {
  const normalizedType = normalizeEntryType(type);
  const normalizedPath = sanitizeArchiveEntryPath(rawPath);
  const normalizedSize = normalizedType === 'file' && Number.isFinite(Number(size))
    ? Math.max(0, Number(size))
    : 0;
  return {
    path: normalizedPath,
    rawPath: String(rawPath || ''),
    type: normalizedType,
    size: normalizedSize,
  };
};

const assertZipEntrySupported = (entry: AdmZip.IZipEntry): void => {
  if (entry.header.encrypted) {
    throw makeWorkspaceError('Encrypted archives are not supported', 415);
  }
  const attr = Number(entry.header.attr ?? 0);
  const unixType = (attr >>> 16) & ZIP_FILE_TYPE_MASK;
  if (unixType === ZIP_SYMLINK_MODE) {
    throw makeWorkspaceError('Archive symlink entries are not supported', 415);
  }
};

const zipEntrySize = (entry: AdmZip.IZipEntry): number => {
  const headerSize = Number(entry.header.size);
  if (Number.isFinite(headerSize) && headerSize >= 0) return headerSize;
  return 0;
};

const readZipEntries = async (archivePath: string): Promise<ReadZipResult> => {
  const zip = new AdmZip(archivePath, { decoder: zipFilenameDecoder });
  const entries: ZipArchiveEntry[] = [];
  for (const entry of zip.getEntries()) {
    assertZipEntrySupported(entry);
    const entryName = entry.header.flags_efs === false
      ? entry.entryName
      : decodeZipFilename(entry.rawEntryName, false);
    entries.push({
      ...createArchiveEntry(entryName, entry.isDirectory ? 'directory' : 'file', zipEntrySize(entry)),
      zipEntry: entry,
    });
  }
  return { entries, zip };
};

const tarEntryType = (entry: { type?: string | undefined }): ArchiveEntryType => {
  if (entry.type && TAR_DIRECTORY_TYPES.has(entry.type)) return 'directory';
  if (entry.type && TAR_FILE_TYPES.has(entry.type)) return 'file';
  throw makeWorkspaceError('Archive contains unsupported entry type', 415);
};

const readTarEntries = async (archivePath: string): Promise<ReadTarResult> => {
  const entries: ArchiveEntry[] = [];
  await tarList({
    file: archivePath,
    strict: true,
    onReadEntry: (entry) => {
      entries.push(createArchiveEntry(entry.path, tarEntryType(entry), entry.size));
    },
    onwarn: (_code, message) => {
      throw makeWorkspaceError(message || 'Archive could not be read', 415);
    },
  });
  return { entries };
};

const assertNoArchivePathCollisions = (entries: ArchiveEntry[]): void => {
  const seen = new Set<string>();
  const filePaths = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) {
      throw new WorkspaceConflictError('Archive contains duplicate entries');
    }
    seen.add(entry.path);
    if (entry.type === 'file') {
      filePaths.add(entry.path);
    }
  }

  for (const entry of entries) {
    const segments = entry.path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join('/');
      if (filePaths.has(parent)) {
        throw new WorkspaceConflictError('Archive contains conflicting file and directory paths');
      }
    }
  }
};

const analyzeEntries = (entries: ArchiveEntry[], config: WorkspaceConfig): ArchiveAnalysis => {
  assertNoArchivePathCollisions(entries);

  let totalFiles = 0;
  let totalDirectories = 0;
  let totalBytes = 0;
  const previewEntries: ArchivePreviewEntry[] = [];
  const previewLimit = Number.isFinite(config.archivePreviewLimit) ? config.archivePreviewLimit : 500;
  const maxFiles = Number.isFinite(config.maxExtractFiles) ? config.maxExtractFiles : 5000;
  const maxBytes = Number.isFinite(config.maxExtractBytes) ? config.maxExtractBytes : 500 * 1024 * 1024;

  for (const entry of entries) {
    if (entry.type === 'directory') {
      totalDirectories += 1;
    } else {
      totalFiles += 1;
      totalBytes += entry.size;
    }

    if (previewEntries.length < previewLimit) {
      previewEntries.push({
        path: entry.path,
        type: entry.type,
        size: entry.size,
      });
    }

    if (totalFiles > maxFiles) {
      throw new WorkspacePayloadTooLargeError('Archive contains too many files');
    }
    if (totalBytes > maxBytes) {
      throw new WorkspacePayloadTooLargeError('Archive is too large to extract');
    }
  }

  return {
    entries,
    previewEntries,
    totalFiles,
    totalDirectories,
    totalBytes,
    truncated: entries.length > previewEntries.length,
  };
};

const loadArchive = async (
  resolvedArchive: ResolvedWorkspacePath,
  format: ArchiveFormat,
  config: WorkspaceConfig,
  dependencies: ArchiveDependencies = {},
): Promise<ArchiveAnalysis> => {
  const {
    fsPromises = fs.promises,
  } = dependencies;
  const stat = await fsPromises.stat(resolvedArchive.absolutePath);
  if (!stat.isFile()) {
    throw makeWorkspaceError('Archive path is not a file');
  }
  if (stat.size > config.maxArchiveBytes) {
    throw new WorkspacePayloadTooLargeError('Archive file is too large');
  }

  try {
    const loaded = format === 'zip'
      ? await readZipEntries(resolvedArchive.absolutePath)
      : await readTarEntries(resolvedArchive.absolutePath);
    return analyzeEntries(loaded.entries, config);
  } catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error && Number.isInteger((error as { statusCode: unknown }).statusCode)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : 'Archive could not be read';
    throw makeWorkspaceError(message, 415);
  }
};

const resolveArchive = async (
  archivePathValue: string,
  config: WorkspaceConfig,
  dependencies: ArchiveDependencies = {},
): Promise<ResolveArchiveResult> => {
  const {
    fsPromises = fs.promises,
    pathModule = path,
  } = dependencies;
  await ensureWorkspaceRoot(config, fsPromises);
  const resolved = await resolveWorkspacePath(archivePathValue, {
    root: config.root,
    fsPromises,
    pathModule,
  }) as ResolvedWorkspacePath;
  const format = detectArchiveFormat(resolved.relativePath);
  if (!format) {
    throw makeWorkspaceError('Unsupported archive format', 415);
  }
  return { resolved, format };
};

const assertAbsolutePathInside = (
  absolutePath: string,
  rootPath: string,
  pathModule: typeof path,
): void => {
  if (!isPathWithinRoot(absolutePath, rootPath, pathModule)) {
    throw makeWorkspaceError('Archive entry escapes destination', 403);
  }
};

const writeZipToDirectory = async (
  archivePath: string,
  entries: ArchiveEntry[],
  targetDir: string,
  dependencies: ArchiveDependencies,
): Promise<void> => {
  const {
    fsPromises = fs.promises,
    pathModule = path,
  } = dependencies;
  const zip = new AdmZip(archivePath, { decoder: zipFilenameDecoder });
  const entriesByPath = new Map<string, AdmZip.IZipEntry>(zip.getEntries().map((entry) => {
    const entryName = entry.header.flags_efs === false
      ? entry.entryName
      : decodeZipFilename(entry.rawEntryName, false);
    return [sanitizeArchiveEntryPath(entryName), entry];
  }));

  for (const entry of entries) {
    const target = pathModule.resolve(targetDir, ...entry.path.split('/'));
    assertAbsolutePathInside(target, targetDir, pathModule);
    if (entry.type === 'directory') {
      await fsPromises.mkdir(target, { recursive: true });
      continue;
    }

    const zipEntry = entriesByPath.get(entry.path);
    if (!zipEntry) {
      throw makeWorkspaceError('Archive entry could not be read', 415);
    }
    await fsPromises.mkdir(pathModule.dirname(target), { recursive: true });
    await fsPromises.writeFile(target, zipEntry.getData());
  }
};

const writeTarToDirectory = async (
  archivePath: string,
  targetDir: string,
  dependencies: ArchiveDependencies,
): Promise<void> => {
  const {
    pathModule = path,
  } = dependencies;
  await tarExtract({
    file: archivePath,
    cwd: targetDir,
    strict: true,
    preserveOwner: false,
    noChmod: true,
    noMtime: true,
    filter: (entryPath, entry) => {
      const normalized = sanitizeArchiveEntryPath(entryPath);
      tarEntryType(entry as { type?: string | undefined });
      const target = pathModule.resolve(targetDir, ...normalized.split('/'));
      assertAbsolutePathInside(target, targetDir, pathModule);
      return true;
    },
    onwarn: (_code, message) => {
      throw makeWorkspaceError(message || 'Archive could not be extracted', 415);
    },
  });
};

const createTemporaryExtractDir = async (
  config: WorkspaceConfig,
  dependencies: ArchiveDependencies = {},
): Promise<ResolvedWorkspacePath> => {
  const {
    fsPromises = fs.promises,
    pathModule = path,
  } = dependencies;
  const name = `.extracting-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const resolved = await resolveWorkspacePath(name, {
    root: config.root,
    fsPromises,
    pathModule,
    allowMissing: true,
  }) as ResolvedWorkspacePath;
  await fsPromises.mkdir(resolved.absolutePath, { recursive: true });
  return resolved;
};

export const resolveArchiveDestination = async (
  payload: ExtractPayload,
  archiveRelativePath: string,
  config: WorkspaceConfig,
  dependencies: ArchiveDependencies = {},
): Promise<ResolveArchiveDestinationResult> => {
  const {
    fsPromises = fs.promises,
    pathModule = path,
  } = dependencies;
  const mode: ArchiveExtractMode = payload?.mode === 'merge' ? 'merge' : 'new-folder';
  const archiveParent = parentPathOf(archiveRelativePath);
  const archiveName = pathModule.basename(archiveRelativePath);
  const defaultName = stripArchiveExtension(archiveName) || 'archive';
  const defaultDestination = mode === 'merge' ? archiveParent : childPath(archiveParent, defaultName);
  const destinationValue = typeof payload?.destination === 'string' && payload.destination.trim().length > 0
    ? payload.destination
    : defaultDestination;
  const destination = await resolveWorkspacePath(destinationValue, {
    root: config.root,
    fsPromises,
    pathModule,
    allowMissing: true,
  }) as ResolvedWorkspacePath;
  if (mode === 'new-folder' && !destination.relativePath) {
    throw makeWorkspaceError('Extract destination is required');
  }
  return { mode, destination };
};

const exists = async (
  absolutePath: string,
  fsPromises: typeof fs.promises,
): Promise<fs.Stats | null> => {
  try {
    return await fsPromises.lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
};

export const allocateConflictPath = async (
  absolutePath: string,
  dependencies: ArchiveDependencies = {},
): Promise<string> => {
  const {
    fsPromises = fs.promises,
    pathModule = path,
  } = dependencies;
  if (!await exists(absolutePath, fsPromises)) {
    return absolutePath;
  }

  const dir = pathModule.dirname(absolutePath);
  const ext = pathModule.extname(absolutePath);
  const base = pathModule.basename(absolutePath, ext);
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = pathModule.join(dir, `${base} (${index})${ext}`);
    if (!await exists(candidate, fsPromises)) {
      return candidate;
    }
  }
  throw new WorkspaceConflictError('Could not allocate a non-conflicting path');
};

const summarizeTree = async (
  absolutePath: string,
  dependencies: ArchiveDependencies = {},
): Promise<ExtractStats> => {
  const {
    fsPromises = fs.promises,
    pathModule = path,
  } = dependencies;
  const stat = await fsPromises.lstat(absolutePath);
  if (!stat.isDirectory()) {
    return { filesCreated: 1, directoriesCreated: 0, bytesWritten: stat.size, conflictsRenamed: 0, conflictsSkipped: 0 };
  }

  let filesCreated = 0;
  let directoriesCreated = 1;
  let bytesWritten = 0;
  const children = await fsPromises.readdir(absolutePath);
  for (const child of children) {
    const childSummary = await summarizeTree(pathModule.join(absolutePath, child), dependencies);
    filesCreated += childSummary.filesCreated;
    directoriesCreated += childSummary.directoriesCreated;
    bytesWritten += childSummary.bytesWritten;
  }
  return { filesCreated, directoriesCreated, bytesWritten, conflictsRenamed: 0, conflictsSkipped: 0 };
};

const mergeOne = async (
  sourcePath: string,
  destinationPath: string,
  conflict: ArchiveConflictMode,
  dependencies: ArchiveDependencies,
  stats: ExtractStats,
): Promise<void> => {
  const {
    fsPromises = fs.promises,
    pathModule = path,
  } = dependencies;
  const sourceStat = await fsPromises.lstat(sourcePath);
  const destinationStat = await exists(destinationPath, fsPromises);

  if (!destinationStat) {
    await fsPromises.mkdir(pathModule.dirname(destinationPath), { recursive: true });
    const summary = await summarizeTree(sourcePath, dependencies);
    await fsPromises.rename(sourcePath, destinationPath);
    stats.filesCreated += summary.filesCreated;
    stats.directoriesCreated += summary.directoriesCreated;
    stats.bytesWritten += summary.bytesWritten;
    return;
  }

  if (sourceStat.isDirectory() && destinationStat.isDirectory()) {
    const children = await fsPromises.readdir(sourcePath);
    for (const child of children) {
      await mergeOne(pathModule.join(sourcePath, child), pathModule.join(destinationPath, child), conflict, dependencies, stats);
    }
    await fsPromises.rm(sourcePath, { recursive: true, force: true });
    return;
  }

  if (conflict === 'skip') {
    await fsPromises.rm(sourcePath, { recursive: true, force: true });
    stats.conflictsSkipped += 1;
    return;
  }
  if (conflict === 'error') {
    throw new WorkspaceConflictError('Extract destination already contains one or more entries');
  }

  const renamedDestination = await allocateConflictPath(destinationPath, dependencies);
  const summary = await summarizeTree(sourcePath, dependencies);
  await fsPromises.rename(sourcePath, renamedDestination);
  stats.filesCreated += summary.filesCreated;
  stats.directoriesCreated += summary.directoriesCreated;
  stats.bytesWritten += summary.bytesWritten;
  stats.conflictsRenamed += 1;
};

const mergeDirectoryContents = async (
  sourceDir: string,
  destinationDir: string,
  conflict: ArchiveConflictMode,
  dependencies: ArchiveDependencies = {},
): Promise<ExtractStats> => {
  const {
    fsPromises = fs.promises,
    pathModule = path,
  } = dependencies;
  await fsPromises.mkdir(destinationDir, { recursive: true });
  const stats: ExtractStats = {
    filesCreated: 0,
    directoriesCreated: 0,
    bytesWritten: 0,
    conflictsRenamed: 0,
    conflictsSkipped: 0,
  };
  const children = await fsPromises.readdir(sourceDir);
  for (const child of children) {
    await mergeOne(pathModule.join(sourceDir, child), pathModule.join(destinationDir, child), conflict, dependencies, stats);
  }
  return stats;
};

export const previewWorkspaceArchive = async (
  archivePathValue: string,
  config: WorkspaceConfig,
  dependencies: ArchiveDependencies = {},
): Promise<ArchivePreviewResult> => {
  const {
    fsPromises = fs.promises,
    pathModule = path,
  } = dependencies;
  const { resolved, format } = await resolveArchive(archivePathValue, config, dependencies);
  const analysis = await loadArchive(resolved, format, config, dependencies);
  return {
    archive: await createWorkspaceEntry(resolved.absolutePath, {
      rootPath: resolved.rootPath,
      fsPromises,
      pathModule,
    }),
    format,
    entries: analysis.previewEntries,
    totalFiles: analysis.totalFiles,
    totalDirectories: analysis.totalDirectories,
    totalBytes: analysis.totalBytes,
    truncated: analysis.truncated,
  };
};

export const extractWorkspaceArchive = async (
  payload: ExtractPayload,
  config: WorkspaceConfig,
  dependencies: ArchiveDependencies = {},
): Promise<ExtractResult> => {
  const {
    fsPromises = fs.promises,
    pathModule = path,
  } = dependencies;
  const archivePathValue = payload?.path ?? '';
  const conflict: ArchiveConflictMode = ['rename', 'skip', 'error'].includes(payload?.conflict ?? '') ? (payload!.conflict as ArchiveConflictMode) : DEFAULT_CONFLICT;
  const { resolved: archive, format } = await resolveArchive(archivePathValue, config, dependencies);
  const analysis = await loadArchive(archive, format, config, dependencies);
  const { mode, destination } = await resolveArchiveDestination(payload, archive.relativePath, config, dependencies);
  const temporary = await createTemporaryExtractDir(config, dependencies);
  let finalDestination = destination.absolutePath;
  let deletedArchive = false;
  const stats: ExtractStats = {
    filesCreated: 0,
    directoriesCreated: 0,
    bytesWritten: 0,
    conflictsRenamed: 0,
    conflictsSkipped: 0,
  };

  try {
    if (format === 'zip') {
      await writeZipToDirectory(archive.absolutePath, analysis.entries, temporary.absolutePath, dependencies);
    } else {
      await writeTarToDirectory(archive.absolutePath, temporary.absolutePath, dependencies);
    }

    const destinationStat = await exists(destination.absolutePath, fsPromises);
    if (mode === 'new-folder' && !destinationStat) {
      finalDestination = destination.absolutePath;
      await fsPromises.mkdir(pathModule.dirname(finalDestination), { recursive: true });
      await fsPromises.rename(temporary.absolutePath, finalDestination);
      stats.filesCreated = analysis.totalFiles;
      stats.directoriesCreated = analysis.totalDirectories;
      stats.bytesWritten = analysis.totalBytes;
    } else if (mode === 'new-folder' && conflict === 'rename') {
      finalDestination = await allocateConflictPath(destination.absolutePath, dependencies);
      await fsPromises.mkdir(pathModule.dirname(finalDestination), { recursive: true });
      await fsPromises.rename(temporary.absolutePath, finalDestination);
      stats.filesCreated = analysis.totalFiles;
      stats.directoriesCreated = analysis.totalDirectories;
      stats.bytesWritten = analysis.totalBytes;
      stats.conflictsRenamed = 1;
    } else if (mode === 'new-folder' && conflict === 'error') {
      throw new WorkspaceConflictError('Extract destination already exists');
    } else {
      await mergeDirectoryContents(temporary.absolutePath, destination.absolutePath, conflict, dependencies)
        .then((mergeStats) => Object.assign(stats, mergeStats));
    }

    if (payload?.deleteArchive === true) {
      await fsPromises.rm(archive.absolutePath, { force: true });
      deletedArchive = true;
    }
  } catch (error) {
    await fsPromises.rm(temporary.absolutePath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  await fsPromises.rm(temporary.absolutePath, { recursive: true, force: true }).catch(() => {});

  const destinationEntry = await createWorkspaceEntry(finalDestination, {
    rootPath: archive.rootPath,
    fsPromises,
    pathModule,
  });
  return {
    success: true,
    destination: destinationEntry.relativePath,
    destinationEntry,
    filesCreated: stats.filesCreated,
    directoriesCreated: stats.directoriesCreated,
    bytesWritten: stats.bytesWritten,
    conflictsRenamed: stats.conflictsRenamed,
    conflictsSkipped: stats.conflictsSkipped,
    deletedArchive,
  };
};
