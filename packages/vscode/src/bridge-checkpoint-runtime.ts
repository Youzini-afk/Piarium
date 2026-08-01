import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type { BridgeContext, BridgeResponse } from './bridge';
import { execGit } from './bridge-git-process-runtime';
import { readSettings } from './bridge-settings-runtime';

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type FileChange = {
  path: string;
  type: 'added' | 'modified' | 'deleted';
  hash?: string;
};

type CheckpointRecord = {
  id: string;
  sessionId: string;
  messageId: string;
  directory: string;
  createdAt: number;
  label?: string;
  phase: 'before-message' | 'before-restore' | 'manual';
  backupDir: string;
  type: 'full' | 'incremental';
  baseCheckpointId?: string;
  changes?: FileChange[];
  fileHashes: Record<string, string>;
  fileCount: number;
  totalBytes: number;
  contentHash: string;
};

type PublicCheckpointRecord = Omit<CheckpointRecord, 'fileHashes'> & {
  hasFileHashes: boolean;
};

type CheckpointMetadata = {
  version: 1;
  records: CheckpointRecord[];
};

type ChangedFileSummary = {
  path: string;
  type: 'added' | 'modified' | 'deleted';
};

type CheckpointCleanupResult = {
  deletedCheckpoints: number;
  deletedSessions: number;
  deletedBytes: number;
  remainingCheckpoints: number;
};

type CheckpointStorageStats = {
  sessionCount: number;
  checkpointCount: number;
  totalBytes: number;
  retentionLimit: number;
};

const METADATA_VERSION = 1 as const;
const STORAGE_DIR_NAME = 'checkpoints-v1';
const METADATA_FILE = 'metadata.json';
const VIRTUAL_DIFF_SCHEME = 'openchamber-checkpoint';
const FORCED_IGNORED_SEGMENTS = new Set(['.git', 'node_modules']);
const DEFAULT_CHECKPOINT_RETENTION_LIMIT = 200;
const MIN_CHECKPOINT_RETENTION_LIMIT = 1;
const MAX_CHECKPOINT_RETENTION_LIMIT = 5000;

const virtualDiffContents = new Map<string, string>();
let virtualDiffProviderRegistered = false;
const sessionLocks = new Map<string, Promise<unknown>>();

const normalizeFsPath = (value: string): string => value.replace(/\\/g, '/');

const normalizeRelativePath = (value: string): string => (
  value
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/$/, '')
);

const hashText = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

const safeDirectoryName = (value: string): string => hashText(value).slice(0, 24);

const createCheckpointId = (): string => {
  const stamp = Date.now().toString(36);
  const random = crypto.randomBytes(5).toString('hex');
  return `cp_${stamp}_${random}`;
};

const isInsideDirectory = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const isSafeRelativePath = (value: string): boolean => {
  const normalized = normalizeRelativePath(value);
  if (
    !normalized
    || path.isAbsolute(value)
    || path.isAbsolute(normalized)
    || /^[a-zA-Z]:\//.test(normalized)
  ) {
    return false;
  }
  return !normalized.split('/').some((segment) => segment === '..' || segment === '');
};

const resolveWorkspaceFilePath = (root: string, relativePathInput: string): { relativePath: string; absolutePath: string } | null => {
  const relativePath = normalizeRelativePath(relativePathInput);
  if (!isSafeRelativePath(relativePath) || isForcedIgnored(relativePath)) {
    return null;
  }
  const absolutePath = path.resolve(root, relativePath);
  if (!isInsideDirectory(root, absolutePath)) {
    return null;
  }
  return { relativePath, absolutePath };
};

const normalizeComparableFsPath = (value: string): string => {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

const normalizeRetentionLimit = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CHECKPOINT_RETENTION_LIMIT;
  }
  return Math.min(
    MAX_CHECKPOINT_RETENTION_LIMIT,
    Math.max(MIN_CHECKPOINT_RETENTION_LIMIT, Math.round(value)),
  );
};

const getCheckpointRetentionLimit = (ctx?: BridgeContext): number => {
  const settings = readSettings(ctx) as { checkpointRetentionLimit?: unknown };
  return normalizeRetentionLimit(settings.checkpointRetentionLimit);
};

const withSessionLock = async <T>(sessionId: string, operation: () => Promise<T>): Promise<T> => {
  const previous = sessionLocks.get(sessionId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  const stored = next.catch(() => undefined);
  sessionLocks.set(sessionId, stored);

  try {
    return await next;
  } finally {
    if (sessionLocks.get(sessionId) === stored) {
      sessionLocks.delete(sessionId);
    }
  }
};

const resolveCheckpointStorageRoot = async (ctx?: BridgeContext): Promise<string> => {
  const base = ctx?.context?.globalStorageUri?.fsPath;
  if (!base) {
    throw new Error('VS Code extension context is not available');
  }
  const root = path.join(base, STORAGE_DIR_NAME);
  await fs.promises.mkdir(root, { recursive: true });
  return root;
};

const getCheckpointStorageRootPath = (ctx?: BridgeContext): string => {
  const base = ctx?.context?.globalStorageUri?.fsPath;
  if (!base) {
    throw new Error('VS Code extension context is not available');
  }
  return path.join(base, STORAGE_DIR_NAME);
};

const resolveSessionStorageDir = async (ctx: BridgeContext | undefined, sessionId: string): Promise<string> => {
  const root = await resolveCheckpointStorageRoot(ctx);
  const dir = path.join(root, safeDirectoryName(sessionId));
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
};

const getSessionStorageDirPath = (ctx: BridgeContext | undefined, sessionId: string): string => (
  path.join(getCheckpointStorageRootPath(ctx), safeDirectoryName(sessionId))
);

const metadataPathForSession = async (ctx: BridgeContext | undefined, sessionId: string): Promise<string> => (
  path.join(await resolveSessionStorageDir(ctx, sessionId), METADATA_FILE)
);

const loadMetadata = async (ctx: BridgeContext | undefined, sessionId: string): Promise<CheckpointMetadata> => {
  const metadataPath = await metadataPathForSession(ctx, sessionId);
  try {
    const raw = await fs.promises.readFile(metadataPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CheckpointMetadata>;
    if (parsed.version === METADATA_VERSION && Array.isArray(parsed.records)) {
      return { version: METADATA_VERSION, records: parsed.records as CheckpointRecord[] };
    }
  } catch {
    // Missing or invalid metadata starts a fresh checkpoint list.
  }
  return { version: METADATA_VERSION, records: [] };
};

const saveMetadata = async (
  ctx: BridgeContext | undefined,
  sessionId: string,
  metadata: CheckpointMetadata,
): Promise<void> => {
  const metadataPath = await metadataPathForSession(ctx, sessionId);
  const tempPath = `${metadataPath}.tmp`;
  await fs.promises.writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  await fs.promises.rename(tempPath, metadataPath);
};

const toPublicRecord = (record: CheckpointRecord): PublicCheckpointRecord => {
  const { fileHashes, ...rest } = record;
  return { ...rest, hasFileHashes: Boolean(fileHashes) };
};

const getWorkspaceDirectory = (directory?: string): string => {
  const raw = typeof directory === 'string' && directory.trim()
    ? directory.trim()
    : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!raw) {
    throw new Error('No workspace directory is available');
  }
  return path.resolve(raw);
};

const isForcedIgnored = (relativePath: string): boolean => (
  normalizeRelativePath(relativePath).split('/').some((segment) => FORCED_IGNORED_SEGMENTS.has(segment))
);

const collectFilesWithGit = async (root: string): Promise<string[] | null> => {
  const result = await execGit(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root).catch(() => null);
  if (!result || result.exitCode !== 0) {
    return null;
  }

  return String(result.stdout || '')
    .split('\0')
    .map((entry) => normalizeRelativePath(entry))
    .filter((entry) => isSafeRelativePath(entry) && !isForcedIgnored(entry))
    .map((entry) => path.resolve(root, entry))
    .filter((entry) => isInsideDirectory(root, entry));
};

const collectFilesByWalking = async (root: string): Promise<string[]> => {
  const files: string[] = [];

  const walk = async (currentDir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
      if (!relativePath || isForcedIgnored(relativePath)) {
        continue;
      }

      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  };

  await walk(root);
  return files;
};

const collectSnapshotFiles = async (root: string): Promise<string[]> => {
  const gitFiles = await collectFilesWithGit(root);
  if (gitFiles) {
    return gitFiles;
  }
  return collectFilesByWalking(root);
};

const buildFileHashes = async (
  root: string,
  files: string[],
): Promise<{ fileHashes: Record<string, string>; totalBytes: number; contentHash: string }> => {
  const fileHashes: Record<string, string> = {};
  let totalBytes = 0;

  for (const absolutePath of [...files].sort((a, b) => a.localeCompare(b))) {
    if (!isInsideDirectory(root, absolutePath)) {
      continue;
    }
    try {
      const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
      if (!isSafeRelativePath(relativePath) || isForcedIgnored(relativePath)) {
        continue;
      }
      const stat = await fs.promises.lstat(absolutePath);
      if (!stat.isFile()) {
        continue;
      }
      const content = await fs.promises.readFile(absolutePath);
      const fileHash = crypto.createHash('sha256').update(content).digest('hex');
      fileHashes[relativePath] = fileHash;
      totalBytes += content.byteLength;
    } catch {
      // Ignore transient read failures. The restore target is defined by what
      // was readable when the checkpoint was created.
    }
  }

  const hashInput = Object.entries(fileHashes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filePath, fileHash]) => `${filePath}:${fileHash}`)
    .join('\n');

  return {
    fileHashes,
    totalBytes,
    contentHash: hashText(hashInput).slice(0, 16),
  };
};

const computeChanges = (
  oldHashes: Record<string, string>,
  newHashes: Record<string, string>,
): { added: string[]; modified: string[]; deleted: string[] } => {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const [filePath, hash] of Object.entries(newHashes)) {
    if (!(filePath in oldHashes)) {
      added.push(filePath);
    } else if (oldHashes[filePath] !== hash) {
      modified.push(filePath);
    }
  }

  for (const filePath of Object.keys(oldHashes)) {
    if (!(filePath in newHashes)) {
      deleted.push(filePath);
    }
  }

  return { added, modified, deleted };
};

const copyFileIntoBackup = async (root: string, backupDir: string, relativePath: string): Promise<boolean> => {
  const resolved = resolveWorkspaceFilePath(root, relativePath);
  if (!resolved) {
    return false;
  }
  const backupRoot = path.resolve(backupDir);
  const target = path.resolve(backupRoot, resolved.relativePath);
  if (!isInsideDirectory(backupRoot, target)) {
    return false;
  }
  try {
    const stat = await fs.promises.lstat(resolved.absolutePath);
    if (!stat.isFile()) {
      return false;
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.copyFile(resolved.absolutePath, target);
    return true;
  } catch {
    return false;
  }
};

const createCheckpointInternal = async (
  ctx: BridgeContext | undefined,
  input: {
    sessionId: string;
    messageId: string;
    directory: string;
    label?: string;
    phase?: CheckpointRecord['phase'];
  },
): Promise<CheckpointRecord> => {
  const root = getWorkspaceDirectory(input.directory);
  const metadata = await loadMetadata(ctx, input.sessionId);
  const checkpointId = createCheckpointId();
  const sessionDir = await resolveSessionStorageDir(ctx, input.sessionId);
  const backupDirName = checkpointId;
  const backupDir = path.join(sessionDir, backupDirName);
  await fs.promises.mkdir(backupDir, { recursive: true });

  const files = await collectSnapshotFiles(root);
  const { fileHashes, totalBytes, contentHash } = await buildFileHashes(root, files);
  const previous = [...metadata.records]
    .reverse()
    .find((record) => path.resolve(record.directory) === root && record.fileHashes);

  let type: CheckpointRecord['type'] = 'full';
  let baseCheckpointId: string | undefined;
  let changes: FileChange[] | undefined;
  let copiedCount = 0;

  if (previous?.fileHashes) {
    const diff = computeChanges(previous.fileHashes, fileHashes);
    type = 'incremental';
    baseCheckpointId = previous.id;
    changes = [
      ...diff.added.map((filePath) => ({ path: filePath, type: 'added' as const, hash: fileHashes[filePath] })),
      ...diff.modified.map((filePath) => ({ path: filePath, type: 'modified' as const, hash: fileHashes[filePath] })),
      ...diff.deleted.map((filePath) => ({ path: filePath, type: 'deleted' as const })),
    ];

    for (const change of changes) {
      if (change.type === 'deleted') {
        continue;
      }
      if (await copyFileIntoBackup(root, backupDir, change.path)) {
        copiedCount++;
      }
    }
  } else {
    const relativePaths = Object.keys(fileHashes);
    for (const relativePath of relativePaths) {
      if (await copyFileIntoBackup(root, backupDir, relativePath)) {
        copiedCount++;
      }
    }
  }

  const record: CheckpointRecord = {
    id: checkpointId,
    sessionId: input.sessionId,
    messageId: input.messageId,
    directory: normalizeFsPath(root),
    createdAt: Date.now(),
    label: input.label,
    phase: input.phase ?? 'before-message',
    backupDir: backupDirName,
    type,
    baseCheckpointId,
    changes,
    fileHashes,
    fileCount: Object.keys(fileHashes).length,
    totalBytes,
    contentHash,
  };

  metadata.records.push(record);
  await saveMetadata(ctx, input.sessionId, metadata);
  await cleanupSessionMetadata(ctx, input.sessionId, {
    directory: root,
    limit: getCheckpointRetentionLimit(ctx),
  }).catch((error) => {
    console.warn('[Checkpoint] Failed to prune old checkpoints after create', error);
  });

  console.log(
    `[Checkpoint] Created ${type} checkpoint ${checkpointId}: files=${record.fileCount}, copied=${copiedCount}, bytes=${totalBytes}`,
  );

  return record;
};

const getIncrementalChain = (
  records: CheckpointRecord[],
  target: CheckpointRecord,
): CheckpointRecord[] => {
  const chain: CheckpointRecord[] = [];
  let current: CheckpointRecord | undefined = target;

  while (current) {
    chain.unshift(current);
    if (current.type !== 'incremental' || !current.baseCheckpointId) {
      break;
    }
    current = records.find((record) => record.id === current?.baseCheckpointId);
  }

  return chain;
};

const findFileInChain = async (
  sessionDir: string,
  chain: CheckpointRecord[],
  relativePath: string,
): Promise<string | null> => {
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  if (!isSafeRelativePath(normalizedRelativePath)) {
    return null;
  }

  for (let index = chain.length - 1; index >= 0; index--) {
    const backupRoot = path.resolve(sessionDir, chain[index].backupDir);
    const candidate = path.resolve(backupRoot, normalizedRelativePath);
    if (!isInsideDirectory(backupRoot, candidate)) {
      continue;
    }
    try {
      await fs.promises.access(candidate, fs.constants.R_OK);
      return candidate;
    } catch {
      // Continue searching older checkpoints in the chain.
    }
  }
  return null;
};

const getDirectorySize = async (directoryPath: string): Promise<number> => {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const child = path.join(directoryPath, entry.name);
    try {
      if (entry.isDirectory()) {
        total += await getDirectorySize(child);
      } else if (entry.isFile()) {
        total += (await fs.promises.stat(child)).size;
      }
    } catch {
      // Ignore transient stat failures.
    }
  }
  return total;
};

const deleteBackupDirectory = async (sessionDir: string, backupDir: string): Promise<number> => {
  const backupRoot = path.resolve(sessionDir, backupDir);
  if (!isInsideDirectory(sessionDir, backupRoot) || backupRoot === path.resolve(sessionDir)) {
    return 0;
  }
  const deletedBytes = await getDirectorySize(backupRoot);
  await fs.promises.rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
  return deletedBytes;
};

const materializeCheckpointAsFull = async (
  ctx: BridgeContext | undefined,
  sessionId: string,
  metadata: CheckpointMetadata,
  checkpoint: CheckpointRecord,
): Promise<CheckpointRecord> => {
  if (checkpoint.type !== 'incremental') {
    return checkpoint;
  }

  const chain = getIncrementalChain(metadata.records, checkpoint);
  if (chain.length === 0 || chain[0].type === 'incremental') {
    throw new Error('Cannot materialize checkpoint: chain is incomplete');
  }

  const sessionDir = await resolveSessionStorageDir(ctx, sessionId);
  const backupDirName = `${checkpoint.id}_full_${Date.now().toString(36)}`;
  const backupRoot = path.join(sessionDir, backupDirName);
  await fs.promises.mkdir(backupRoot, { recursive: true });

  try {
    for (const relativePath of Object.keys(checkpoint.fileHashes)) {
      const sourcePath = await findFileInChain(sessionDir, chain, relativePath);
      if (!sourcePath) {
        throw new Error(`Cannot materialize checkpoint: missing ${relativePath}`);
      }

      const sourceHash = crypto.createHash('sha256').update(await fs.promises.readFile(sourcePath)).digest('hex');
      if (sourceHash !== checkpoint.fileHashes[relativePath]) {
        throw new Error(`Cannot materialize checkpoint: hash mismatch for ${relativePath}`);
      }

      const resolvedTarget = path.resolve(backupRoot, normalizeRelativePath(relativePath));
      if (!isInsideDirectory(backupRoot, resolvedTarget)) {
        throw new Error(`Cannot materialize checkpoint: unsafe path ${relativePath}`);
      }

      await fs.promises.mkdir(path.dirname(resolvedTarget), { recursive: true });
      await fs.promises.copyFile(sourcePath, resolvedTarget);
    }
  } catch (error) {
    await fs.promises.rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return {
    ...checkpoint,
    backupDir: backupDirName,
    type: 'full',
    baseCheckpointId: undefined,
    changes: undefined,
  };
};

const cleanupSessionMetadata = async (
  ctx: BridgeContext | undefined,
  sessionId: string,
  options: { directory?: string; limit?: number },
): Promise<CheckpointCleanupResult> => {
  const metadata = await loadMetadata(ctx, sessionId);
  const limit = normalizeRetentionLimit(options.limit);
  const sessionDir = await resolveSessionStorageDir(ctx, sessionId);
  const targetDirectory = options.directory ? normalizeFsPath(path.resolve(options.directory)) : null;

  const groups = new Map<string, CheckpointRecord[]>();
  for (const record of metadata.records) {
    const key = normalizeFsPath(path.resolve(record.directory));
    if (targetDirectory && key !== targetDirectory) {
      continue;
    }
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }

  const recordUpdates = new Map<string, CheckpointRecord>();
  const recordsToDelete = new Set<string>();
  let deletedBytes = 0;

  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.createdAt - b.createdAt);
    if (sorted.length <= limit) {
      continue;
    }

    const deleteCount = sorted.length - limit;
    const keep = sorted.slice(deleteCount);
    const firstKept = keep[0];
    if (!firstKept) {
      continue;
    }

    if (firstKept.type === 'incremental') {
      const materialized = await materializeCheckpointAsFull(ctx, sessionId, metadata, firstKept);
      recordUpdates.set(firstKept.id, materialized);
      deletedBytes += await deleteBackupDirectory(sessionDir, firstKept.backupDir);
    }

    for (const record of sorted.slice(0, deleteCount)) {
      recordsToDelete.add(record.id);
      deletedBytes += await deleteBackupDirectory(sessionDir, record.backupDir);
    }
  }

  if (recordsToDelete.size === 0 && recordUpdates.size === 0) {
    return {
      deletedCheckpoints: 0,
      deletedSessions: 0,
      deletedBytes: 0,
      remainingCheckpoints: metadata.records.length,
    };
  }

  const nextRecords = metadata.records
    .filter((record) => !recordsToDelete.has(record.id))
    .map((record) => recordUpdates.get(record.id) ?? record);

  await saveMetadata(ctx, sessionId, { version: METADATA_VERSION, records: nextRecords });

  return {
    deletedCheckpoints: recordsToDelete.size,
    deletedSessions: 0,
    deletedBytes,
    remainingCheckpoints: nextRecords.length,
  };
};

const cleanupSessionStorage = async (
  ctx: BridgeContext | undefined,
  sessionId: string,
): Promise<CheckpointCleanupResult> => {
  const sessionDir = getSessionStorageDirPath(ctx, sessionId);
  const deletedBytes = await getDirectorySize(sessionDir);
  let checkpointCount = 0;
  try {
    const raw = await fs.promises.readFile(path.join(sessionDir, METADATA_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Partial<CheckpointMetadata>;
    checkpointCount = Array.isArray(parsed.records) ? parsed.records.length : 0;
  } catch {
    checkpointCount = 0;
  }
  await fs.promises.rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
  return {
    deletedCheckpoints: checkpointCount,
    deletedSessions: 1,
    deletedBytes,
    remainingCheckpoints: 0,
  };
};

const listCheckpointSessionDirs = async (ctx: BridgeContext | undefined): Promise<string[]> => {
  const root = await resolveCheckpointStorageRoot(ctx);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name));
};

const getCheckpointStorageStats = async (ctx: BridgeContext | undefined): Promise<CheckpointStorageStats> => {
  const sessionDirs = await listCheckpointSessionDirs(ctx);
  let checkpointCount = 0;
  let totalBytes = 0;

  for (const sessionDir of sessionDirs) {
    totalBytes += await getDirectorySize(sessionDir);
    try {
      const raw = await fs.promises.readFile(path.join(sessionDir, METADATA_FILE), 'utf8');
      const parsed = JSON.parse(raw) as Partial<CheckpointMetadata>;
      if (Array.isArray(parsed.records)) {
        checkpointCount += parsed.records.length;
      }
    } catch {
      // Ignore malformed metadata while still counting disk usage.
    }
  }

  return {
    sessionCount: sessionDirs.length,
    checkpointCount,
    totalBytes,
    retentionLimit: getCheckpointRetentionLimit(ctx),
  };
};

const cleanupAllCheckpointStorage = async (ctx: BridgeContext | undefined): Promise<CheckpointCleanupResult> => {
  const root = await resolveCheckpointStorageRoot(ctx);
  const stats = await getCheckpointStorageStats(ctx);
  await fs.promises.rm(root, { recursive: true, force: true }).catch(() => undefined);
  await fs.promises.mkdir(root, { recursive: true });
  return {
    deletedCheckpoints: stats.checkpointCount,
    deletedSessions: stats.sessionCount,
    deletedBytes: stats.totalBytes,
    remainingCheckpoints: 0,
  };
};

const cleanupAllSessionsByRetention = async (
  ctx: BridgeContext | undefined,
  limit: number,
): Promise<CheckpointCleanupResult> => {
  const sessionDirs = await listCheckpointSessionDirs(ctx);
  let result: CheckpointCleanupResult = {
    deletedCheckpoints: 0,
    deletedSessions: 0,
    deletedBytes: 0,
    remainingCheckpoints: 0,
  };

  for (const sessionDir of sessionDirs) {
    let metadata: CheckpointMetadata | null = null;
    try {
      const raw = await fs.promises.readFile(path.join(sessionDir, METADATA_FILE), 'utf8');
      const parsed = JSON.parse(raw) as Partial<CheckpointMetadata>;
      if (parsed.version === METADATA_VERSION && Array.isArray(parsed.records)) {
        metadata = { version: METADATA_VERSION, records: parsed.records as CheckpointRecord[] };
      }
    } catch {
      metadata = null;
    }

    const sessionId = metadata?.records.find((record) => typeof record.sessionId === 'string')?.sessionId;
    if (!sessionId) {
      continue;
    }

    const cleanup = await withSessionLock(sessionId, () => cleanupSessionMetadata(ctx, sessionId, { limit }));
    result = {
      deletedCheckpoints: result.deletedCheckpoints + cleanup.deletedCheckpoints,
      deletedSessions: result.deletedSessions + cleanup.deletedSessions,
      deletedBytes: result.deletedBytes + cleanup.deletedBytes,
      remainingCheckpoints: result.remainingCheckpoints + cleanup.remainingCheckpoints,
    };
  }

  const stats = await getCheckpointStorageStats(ctx);
  return { ...result, remainingCheckpoints: stats.checkpointCount };
};

const removeEmptyParents = async (root: string, startDirectory: string): Promise<void> => {
  let current = startDirectory;
  while (isInsideDirectory(root, current) && current !== root) {
    try {
      const entries = await fs.promises.readdir(current);
      if (entries.length > 0) {
        return;
      }
      await fs.promises.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
};

const restoreTextDocumentIfOpen = async (absolutePath: string, sourcePath: string): Promise<boolean> => {
  const uri = vscode.Uri.file(absolutePath);
  const targetComparablePath = normalizeComparableFsPath(absolutePath);
  const document = vscode.workspace.textDocuments.find((doc) => (
    doc.uri.scheme === 'file' && normalizeComparableFsPath(doc.uri.fsPath) === targetComparablePath
  ));
  if (!document) {
    return false;
  }

  try {
    const content = await fs.promises.readFile(sourcePath, 'utf8');
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
    edit.replace(uri, fullRange, content);
    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) {
      await document.save();
    }
    return applied;
  } catch {
    return false;
  }
};

const refreshAffectedDocuments = async (modifiedFiles: string[], deletedFiles: string[]): Promise<void> => {
  const modified = new Set(modifiedFiles.map(normalizeComparableFsPath));
  const deleted = new Set(deletedFiles.map(normalizeComparableFsPath));
  const affected = new Set([...modified, ...deleted]);
  if (affected.size === 0) {
    return;
  }

  try {
    for (const tabGroup of vscode.window.tabGroups.all) {
      for (const tab of tabGroup.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          const tabPath = normalizeComparableFsPath(tab.input.uri.fsPath);
          if (deleted.has(tabPath)) {
            await vscode.window.tabGroups.close(tab);
          }
          continue;
        }

        if (tab.input instanceof vscode.TabInputTextDiff) {
          const originalPath = tab.input.original.scheme === 'file'
            ? normalizeComparableFsPath(tab.input.original.fsPath)
            : null;
          const modifiedPath = tab.input.modified.scheme === 'file'
            ? normalizeComparableFsPath(tab.input.modified.fsPath)
            : null;
          if ((originalPath && affected.has(originalPath)) || (modifiedPath && affected.has(modifiedPath))) {
            await vscode.window.tabGroups.close(tab);
          }
        }
      }
    }
  } catch (error) {
    console.warn('[Checkpoint] Failed to refresh affected VS Code documents', error);
  }
};

const openCheckpointDiffProvider = (ctx?: BridgeContext): void => {
  if (virtualDiffProviderRegistered || !ctx?.context) {
    return;
  }

  const provider = vscode.workspace.registerTextDocumentContentProvider(VIRTUAL_DIFF_SCHEME, {
    provideTextDocumentContent(uri: vscode.Uri): string {
      return virtualDiffContents.get(uri.toString()) ?? '';
    },
  });
  ctx.context.subscriptions.push(provider);
  virtualDiffProviderRegistered = true;
};

const createVirtualDiffUri = (fileName: string, key: string, content: string): vscode.Uri => {
  const uri = vscode.Uri.from({
    scheme: VIRTUAL_DIFF_SCHEME,
    path: `/${encodeURIComponent(fileName)}`,
    query: key,
  });
  virtualDiffContents.set(uri.toString(), content);
  if (virtualDiffContents.size > 100) {
    const firstKey = virtualDiffContents.keys().next().value;
    if (firstKey) {
      virtualDiffContents.delete(firstKey);
    }
  }
  return uri;
};

const openFileDiff = async (
  ctx: BridgeContext | undefined,
  input: { sessionId: string; checkpointId: string; filePath: string },
): Promise<void> => {
  const metadata = await loadMetadata(ctx, input.sessionId);
  const checkpoint = metadata.records.find((record) => record.id === input.checkpointId);
  if (!checkpoint) {
    throw new Error('Checkpoint not found');
  }

  const root = getWorkspaceDirectory(checkpoint.directory);
  const resolved = resolveWorkspaceFilePath(root, input.filePath);
  if (!resolved) {
    throw new Error('File path is outside the workspace or ignored');
  }

  const sessionDir = await resolveSessionStorageDir(ctx, input.sessionId);
  const chain = getIncrementalChain(metadata.records, checkpoint);
  if (chain.length === 0 || chain[0].type === 'incremental') {
    throw new Error('Checkpoint chain is incomplete');
  }

  const sourcePath = await findFileInChain(sessionDir, chain, resolved.relativePath);
  if (!sourcePath && Object.prototype.hasOwnProperty.call(checkpoint.fileHashes, resolved.relativePath)) {
    throw new Error('Checkpoint file is missing from the backup chain');
  }

  openCheckpointDiffProvider(ctx);
  const key = `${checkpoint.id}:${resolved.relativePath}:${Date.now()}`;
  const fileName = path.basename(resolved.relativePath);
  const virtualEmptyUri = () => createVirtualDiffUri(fileName, `${key}:${crypto.randomBytes(3).toString('hex')}`, '');
  const originalUri = sourcePath ? vscode.Uri.file(sourcePath) : virtualEmptyUri();
  let modifiedUri = vscode.Uri.file(resolved.absolutePath);
  try {
    await fs.promises.access(resolved.absolutePath, fs.constants.R_OK);
  } catch {
    modifiedUri = virtualEmptyUri();
  }

  await vscode.commands.executeCommand(
    'vscode.diff',
    originalUri,
    modifiedUri,
    `${resolved.relativePath} (checkpoint)`,
    { preview: false },
  );
};

const getCheckpointDiff = async (
  ctx: BridgeContext | undefined,
  sessionId: string,
  checkpointId: string,
): Promise<{ files: ChangedFileSummary[] }> => {
  const metadata = await loadMetadata(ctx, sessionId);
  const checkpoint = metadata.records.find((record) => record.id === checkpointId);
  if (!checkpoint) {
    throw new Error('Checkpoint not found');
  }

  const root = getWorkspaceDirectory(checkpoint.directory);
  const currentFiles = await collectSnapshotFiles(root);
  const { fileHashes: currentHashes } = await buildFileHashes(root, currentFiles);
  const changes = computeChanges(checkpoint.fileHashes, currentHashes);

  return {
    files: [
      ...changes.added.map((filePath) => ({ path: filePath, type: 'added' as const })),
      ...changes.modified.map((filePath) => ({ path: filePath, type: 'modified' as const })),
      ...changes.deleted.map((filePath) => ({ path: filePath, type: 'deleted' as const })),
    ],
  };
};

type CheckpointRestoreReviewResult = {
  restore: boolean;
  cancelled?: boolean;
  changedCount: number;
  openedDiff?: boolean;
};

const formatChangeDescription = (type: ChangedFileSummary['type']): string => {
  switch (type) {
    case 'added':
      return 'added after checkpoint';
    case 'modified':
      return 'modified after checkpoint';
    case 'deleted':
      return 'deleted after checkpoint';
    default:
      return type;
  }
};

const formatChangeIcon = (type: ChangedFileSummary['type']): string => {
  switch (type) {
    case 'added':
      return '$(diff-added)';
    case 'modified':
      return '$(diff-modified)';
    case 'deleted':
      return '$(diff-removed)';
    default:
      return '$(diff)';
  }
};

const reviewCheckpointRestore = async (
  ctx: BridgeContext | undefined,
  sessionId: string,
  checkpointId: string,
): Promise<CheckpointRestoreReviewResult> => {
  const { files } = await getCheckpointDiff(ctx, sessionId, checkpointId);
  if (files.length === 0) {
    vscode.window.setStatusBarMessage('OpenChamber checkpoint: no workspace file changes to restore', 4000);
    return { restore: false, changedCount: 0, openedDiff: false };
  }

  const viewDiffLabel = 'View Diff';
  const restoreLabel = 'Restore Files';
  const chatOnlyLabel = 'Chat Only';
  const cancelLabel = 'Cancel Revert';
  let openedDiff = false;

  while (true) {
    const selected = await vscode.window.showWarningMessage(
      `OpenChamber: ${files.length} workspace file${files.length === 1 ? ' has' : 's have'} changed since this chat point.`,
      {
        modal: true,
        detail: 'Choose View Diff to inspect a file, Restore Files to make the workspace match this chat point, or Chat Only to keep the current files. A safety checkpoint is created before restore.',
      },
      viewDiffLabel,
      restoreLabel,
      chatOnlyLabel,
      cancelLabel,
    );

    if (selected === restoreLabel) {
      return { restore: true, changedCount: files.length, openedDiff };
    }
    if (selected === chatOnlyLabel) {
      return { restore: false, changedCount: files.length, openedDiff };
    }
    if (selected === cancelLabel || !selected) {
      return { restore: false, cancelled: true, changedCount: files.length, openedDiff };
    }
    if (selected !== viewDiffLabel) {
      continue;
    }

    const picked = await vscode.window.showQuickPick(
      files.map((file) => ({
        label: `${formatChangeIcon(file.type)} ${path.basename(file.path)}`,
        description: formatChangeDescription(file.type),
        detail: file.path,
        file,
      })),
      {
        title: 'OpenChamber Checkpoint Diff',
        placeHolder: 'Select a file to compare with the checkpoint',
        matchOnDescription: true,
        matchOnDetail: true,
      },
    );

    if (picked?.file) {
      await openFileDiff(ctx, { sessionId, checkpointId, filePath: picked.file.path });
      openedDiff = true;
    }
  }
};

const restoreCheckpoint = async (
  ctx: BridgeContext | undefined,
  input: { sessionId: string; checkpointId: string; createSafetyCheckpoint?: boolean },
): Promise<{ success: boolean; restored: number; deleted: number; skipped: number; safetyCheckpoint?: PublicCheckpointRecord }> => {
  const metadata = await loadMetadata(ctx, input.sessionId);
  const checkpoint = metadata.records.find((record) => record.id === input.checkpointId);
  if (!checkpoint) {
    throw new Error('Checkpoint not found');
  }

  let safetyCheckpoint: PublicCheckpointRecord | undefined;
  if (input.createSafetyCheckpoint !== false) {
    const safety = await createCheckpointInternal(ctx, {
      sessionId: input.sessionId,
      messageId: `restore_${Date.now()}`,
      directory: checkpoint.directory,
      label: 'Before checkpoint restore',
      phase: 'before-restore',
    });
    safetyCheckpoint = toPublicRecord(safety);
  }

  const freshMetadata = await loadMetadata(ctx, input.sessionId);
  const freshCheckpoint = freshMetadata.records.find((record) => record.id === input.checkpointId) ?? checkpoint;
  const root = getWorkspaceDirectory(freshCheckpoint.directory);
  const sessionDir = await resolveSessionStorageDir(ctx, input.sessionId);
  const chain = getIncrementalChain(freshMetadata.records, freshCheckpoint);
  if (chain.length === 0 || chain[0].type === 'incremental') {
    throw new Error('Checkpoint chain is incomplete');
  }

  const currentFiles = await collectSnapshotFiles(root);
  const { fileHashes: currentHashes } = await buildFileHashes(root, currentFiles);
  const targetHashes = freshCheckpoint.fileHashes;
  const diff = computeChanges(currentHashes, targetHashes);

  let restored = 0;
  let deleted = 0;
  let skipped = Object.keys(targetHashes).length - diff.added.length - diff.modified.length;
  if (skipped < 0) {
    skipped = 0;
  }
  const modifiedFiles: string[] = [];
  const deletedFiles: string[] = [];

  for (const relativePath of diff.deleted) {
    const resolved = resolveWorkspaceFilePath(root, relativePath);
    if (!resolved) {
      continue;
    }
    try {
      await fs.promises.rm(resolved.absolutePath, { force: true });
      deleted++;
      deletedFiles.push(resolved.absolutePath);
      await removeEmptyParents(root, path.dirname(resolved.absolutePath));
    } catch {
      // Best effort restore: continue with the remaining files.
    }
  }

  for (const relativePath of [...diff.added, ...diff.modified]) {
    const resolved = resolveWorkspaceFilePath(root, relativePath);
    if (!resolved) {
      continue;
    }

    const sourcePath = await findFileInChain(sessionDir, chain, relativePath);
    if (!sourcePath) {
      continue;
    }

    try {
      const sourceHash = crypto.createHash('sha256').update(await fs.promises.readFile(sourcePath)).digest('hex');
      if (sourceHash !== targetHashes[relativePath]) {
        continue;
      }

      await fs.promises.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
      const refreshedOpenDocument = await restoreTextDocumentIfOpen(resolved.absolutePath, sourcePath);
      if (!refreshedOpenDocument) {
        await fs.promises.copyFile(sourcePath, resolved.absolutePath);
      }
      restored++;
      modifiedFiles.push(resolved.absolutePath);
    } catch {
      // Best effort restore: continue with the remaining files.
    }
  }

  await refreshAffectedDocuments(modifiedFiles, deletedFiles);

  vscode.window.setStatusBarMessage(
    `OpenChamber restored checkpoint: ${restored} updated, ${deleted} deleted, ${skipped} unchanged`,
    5000,
  );

  return { success: true, restored, deleted, skipped, safetyCheckpoint };
};

export async function handleCheckpointBridgeMessage(
  message: BridgeMessageInput,
  ctx?: BridgeContext,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;

  switch (type) {
    case 'api:checkpoint/create': {
      const body = (payload || {}) as {
        sessionId?: string;
        messageId?: string;
        directory?: string;
        label?: string;
        phase?: CheckpointRecord['phase'];
      };
      if (!body.sessionId || !body.messageId) {
        return { id, type, success: false, error: 'sessionId and messageId are required' };
      }
      const record = await withSessionLock(body.sessionId, () => createCheckpointInternal(ctx, {
        sessionId: body.sessionId!,
        messageId: body.messageId!,
        directory: getWorkspaceDirectory(body.directory),
        label: body.label,
        phase: body.phase,
      }));
      return { id, type, success: true, data: { checkpoint: toPublicRecord(record) } };
    }

    case 'api:checkpoint/get-for-message': {
      const body = (payload || {}) as { sessionId?: string; messageId?: string; directory?: string };
      if (!body.sessionId || !body.messageId) {
        return { id, type, success: false, error: 'sessionId and messageId are required' };
      }
      const metadata = await loadMetadata(ctx, body.sessionId);
      const targetDirectory = body.directory ? normalizeFsPath(path.resolve(body.directory)) : null;
      const checkpoint = [...metadata.records]
        .reverse()
        .find((record) => (
          record.messageId === body.messageId
          && (!targetDirectory || normalizeFsPath(path.resolve(record.directory)) === targetDirectory)
        ));
      return {
        id,
        type,
        success: true,
        data: { checkpoint: checkpoint ? toPublicRecord(checkpoint) : null },
      };
    }

    case 'api:checkpoint/list': {
      const body = (payload || {}) as { sessionId?: string };
      if (!body.sessionId) {
        return { id, type, success: false, error: 'sessionId is required' };
      }
      const metadata = await loadMetadata(ctx, body.sessionId);
      return { id, type, success: true, data: { checkpoints: metadata.records.map(toPublicRecord) } };
    }

    case 'api:checkpoint/stats': {
      const stats = await getCheckpointStorageStats(ctx);
      return { id, type, success: true, data: stats };
    }

    case 'api:checkpoint/cleanup-session': {
      const body = (payload || {}) as { sessionId?: string };
      if (!body.sessionId) {
        return { id, type, success: false, error: 'sessionId is required' };
      }
      const result = await withSessionLock(body.sessionId, () => cleanupSessionStorage(ctx, body.sessionId!));
      return { id, type, success: true, data: result };
    }

    case 'api:checkpoint/cleanup-retention': {
      const body = (payload || {}) as { limit?: unknown };
      const result = await cleanupAllSessionsByRetention(
        ctx,
        normalizeRetentionLimit(body.limit ?? getCheckpointRetentionLimit(ctx)),
      );
      return { id, type, success: true, data: result };
    }

    case 'api:checkpoint/cleanup-all': {
      const result = await cleanupAllCheckpointStorage(ctx);
      return { id, type, success: true, data: result };
    }

    case 'api:checkpoint/diff': {
      const body = (payload || {}) as { sessionId?: string; checkpointId?: string };
      if (!body.sessionId || !body.checkpointId) {
        return { id, type, success: false, error: 'sessionId and checkpointId are required' };
      }
      const diff = await getCheckpointDiff(ctx, body.sessionId, body.checkpointId);
      return { id, type, success: true, data: diff };
    }

    case 'api:checkpoint/open-file-diff': {
      const body = (payload || {}) as { sessionId?: string; checkpointId?: string; filePath?: string };
      if (!body.sessionId || !body.checkpointId || !body.filePath) {
        return { id, type, success: false, error: 'sessionId, checkpointId and filePath are required' };
      }
      await openFileDiff(ctx, {
        sessionId: body.sessionId,
        checkpointId: body.checkpointId,
        filePath: body.filePath,
      });
      return { id, type, success: true, data: { success: true } };
    }

    case 'api:checkpoint/review-restore': {
      const body = (payload || {}) as { sessionId?: string; checkpointId?: string };
      if (!body.sessionId || !body.checkpointId) {
        return { id, type, success: false, error: 'sessionId and checkpointId are required' };
      }
      const result = await reviewCheckpointRestore(ctx, body.sessionId, body.checkpointId);
      return { id, type, success: true, data: result };
    }

    case 'api:checkpoint/restore': {
      const body = (payload || {}) as {
        sessionId?: string;
        checkpointId?: string;
        createSafetyCheckpoint?: boolean;
      };
      if (!body.sessionId || !body.checkpointId) {
        return { id, type, success: false, error: 'sessionId and checkpointId are required' };
      }
      const result = await withSessionLock(body.sessionId, () => restoreCheckpoint(ctx, {
        sessionId: body.sessionId!,
        checkpointId: body.checkpointId!,
        createSafetyCheckpoint: body.createSafetyCheckpoint,
      }));
      return { id, type, success: true, data: result };
    }

    default:
      return null;
  }
}
