const FILE_SEARCH_MAX_CONCURRENCY = 5;
const FILE_SEARCH_EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  'tmp',
  'logs',
]);

const normalizeRelativeSearchPath = (rootPath: string, targetPath: string, path: PathModule): string => {
  const relative = path.relative(rootPath, targetPath) || path.basename(targetPath);
  return relative.split(path.sep).join('/') || targetPath;
};

const shouldSkipSearchDirectory = (name: string, includeHidden: boolean): boolean => {
  if (!name) {
    return false;
  }
  if (!includeHidden && name.startsWith('.')) {
    return true;
  }
  return FILE_SEARCH_EXCLUDED_DIRS.has(name.toLowerCase());
};

const listDirectoryEntries = async (dirPath: string, fsPromises: FsPromises): Promise<{ entries: Dirent[]; failed: boolean }> => {
  try {
    return { entries: await fsPromises.readdir(dirPath, { withFileTypes: true }), failed: false };
  } catch {
    return { entries: [], failed: true };
  }
};

/**
 * Non-ignored paths under a search root, from one `git ls-files` instead of a
 * `git check-ignore` per directory. The catalog scan walks a whole workspace,
 * so the per-directory shape cost one process per directory — 4363 of them on
 * this repository, where the bare walk is 1.6 s (D-140).
 *
 * `--cached --others --exclude-standard` is "tracked, plus untracked that is
 * not ignored", so a file on disk that is absent from this set is ignored.
 * Paths come out relative to the cwd, which is the search root.
 * The returned array carries a non-enumerable `enumerationStatus`; a catalog
 * may reconcile missing graph paths only when that status is `complete`.
 */
interface IgnoreLookup {
  /** The file is tracked or untracked-but-not-ignored. */
  allowsFile(relativePath: string): boolean;
  /** Some non-ignored file lives at or below this directory. */
  allowsDirectory(relativePath: string): boolean;
}

interface IgnoreLookupResult {
  lookup: IgnoreLookup | null;
  status: "complete" | "failed" | "cancelled";
}

const buildIgnoreLookup = async (
  rootPath: string,
  spawn: typeof nodeSpawn,
  resolveGitBinaryForSpawn: () => string,
  signal?: AbortSignal,
): Promise<IgnoreLookupResult> => {
  if (signal?.aborted) return { lookup: null, status: "cancelled" };
  const listed = await new Promise<{ output: string | null; status: IgnoreLookupResult["status"] }>((resolve) => {
    const child = spawn(resolveGitBinaryForSpawn(), ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: rootPath,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let failed = false;
    child.stdout.on('data', (data: Buffer) => { chunks.push(data); });
    child.stderr.on('data', (data: Buffer) => { errors.push(data); });
    child.on('error', () => { failed = true; resolve({ output: null, status: signal?.aborted ? "cancelled" : "failed" }); });
    child.on('close', (code) => {
      if (failed) return;
      if (signal?.aborted) {
        resolve({ output: null, status: "cancelled" });
      } else if (code === 0) {
        resolve({ output: Buffer.concat(chunks).toString('utf8'), status: "complete" });
      } else if (code === 128 && /not a git repository/iu.test(Buffer.concat(errors).toString('utf8'))) {
        // A non-Git workspace has no ignore rules to apply; the directory walk
        // still provides a complete inventory.
        resolve({ output: null, status: "complete" });
      } else {
        resolve({ output: null, status: "failed" });
      }
    });
    signal?.addEventListener('abort', () => child.kill(), { once: true });
  });
  // Not a Git working tree, or git is unavailable: nothing declares an ignore
  // rule, which is the same answer the per-directory probe gave on failure.
  if (listed.status !== "complete") return { lookup: null, status: listed.status };
  if (listed.output === null) return { lookup: null, status: "complete" };
  const files = new Set<string>();
  const directories = new Set<string>();
  for (const entry of listed.output.split('\0')) {
    if (!entry) continue;
    files.add(entry);
    let cut = entry.lastIndexOf('/');
    while (cut > 0) {
      const parent = entry.slice(0, cut);
      if (directories.has(parent)) break;
      directories.add(parent);
      cut = parent.lastIndexOf('/');
    }
  }
  return {
    status: "complete",
    lookup: {
      allowsFile: (relativePath) => files.has(relativePath),
      allowsDirectory: (relativePath) => directories.has(relativePath),
    },
  };
};

const fuzzyMatchScoreNormalized = (normalizedQuery: string, candidate: string): number | null => {
  if (!normalizedQuery) return 0;

  const q = normalizedQuery;
  const c = candidate.toLowerCase();
  if (c.includes(q)) {
    const idx = c.indexOf(q);
    let bonus = 0;
    if (idx === 0) {
      bonus = 20;
    } else {
      const prev = c[idx - 1];
      if (prev === '/' || prev === '_' || prev === '-' || prev === '.' || prev === ' ') {
        bonus = 15;
      }
    }
    return 100 + bonus - Math.min(idx, 20) - Math.floor(c.length / 5);
  }

  let score = 0;
  let lastIndex = -1;
  let consecutive = 0;

  for (let i = 0; i < q.length; i += 1) {
    const ch = q[i];
    if (!ch || ch === ' ') continue;

    const idx = c.indexOf(ch, lastIndex + 1);
    if (idx === -1) {
      return null;
    }

    const gap = idx - lastIndex - 1;
    if (gap === 0) {
      consecutive += 1;
    } else {
      consecutive = 0;
    }

    score += 10;
    score += Math.max(0, 18 - idx);
    score -= Math.min(gap, 10);

    if (idx === 0) {
      score += 12;
    } else {
      const prev = c[idx - 1];
      if (prev === '/' || prev === '_' || prev === '-' || prev === '.' || prev === ' ') {
        score += 10;
      }
    }

    score += consecutive > 0 ? 12 : 0;
    lastIndex = idx;
  }

  score += Math.max(0, 24 - Math.floor(c.length / 3));
  return score;
};

export const createFsSearchRuntime = ({ fsPromises: rawFsPromises, path, spawn: rawSpawn, resolveGitBinaryForSpawn }: {
  fsPromises: unknown;
  path: PathModule;
  resolveGitBinaryForSpawn(): string;
  spawn: unknown;
}) => {
  const fsPromises = rawFsPromises as FsPromises;
  const spawn = rawSpawn as typeof nodeSpawn;
  const isSearchableFile = async (rootPath: string, resourceId: string, signal?: AbortSignal): Promise<boolean> => {
    signal?.throwIfAborted();
    const absolutePath = path.resolve(rootPath, resourceId);
    const relative = path.relative(rootPath, absolutePath).split(path.sep).join('/');
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return false;
    const segments = relative.split('/');
    if (segments.some((segment) => segment.startsWith('.'))
      || segments.slice(0, -1).some((segment) => shouldSkipSearchDirectory(segment, false))) return false;
    try {
      if (!(await fsPromises.lstat(absolutePath)).isFile()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    signal?.throwIfAborted();
    // The cold catalog uses ls-files. For a single mutation, check-ignore has
    // the same tracked/untracked semantics without enumerating the repository.
    return new Promise<boolean>((resolve, reject) => {
      const child = spawn(resolveGitBinaryForSpawn(), ['check-ignore', '--quiet', '--', relative], {
        cwd: rootPath, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, LC_ALL: 'C' },
      });
      const errors: Buffer[] = [];
      const onAbort = (): void => {
        child.kill();
        reject(signal?.reason ?? new DOMException('File eligibility check aborted', 'AbortError'));
      };
      child.stderr.on('data', (data: Buffer) => errors.push(data));
      child.on('error', (error) => {
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      });
      child.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) { onAbort(); return; }
        if (code === 0) resolve(false);
        else if (code === 1 || (code === 128 && /not a git repository/iu.test(Buffer.concat(errors).toString('utf8')))) resolve(true);
        else reject(new Error(`Git could not determine file eligibility (exit ${code})`));
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  };
  const searchFilesystemFiles = async (rootPath: string, options: {
    includeHidden?: boolean;
    limit?: number;
    query: string;
    respectGitignore?: boolean;
    signal?: AbortSignal;
  }): Promise<FileSearchItems> => {
    const { limit, query, includeHidden, respectGitignore, signal } = options;
    const includeHiddenEntries = Boolean(includeHidden);
    const normalizedQuery = query.trim().toLowerCase();
    const matchAll = normalizedQuery.length === 0;
    const queue = [rootPath];
    const visited = new Set([rootPath]);
    const shouldRespectGitignore = respectGitignore !== false;
    const requestedLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : null;
    const collectLimit = requestedLimit === null
      ? Number.POSITIVE_INFINITY
      : matchAll ? requestedLimit : Math.max(requestedLimit * 3, 200);
    const candidates: Array<FileSearchItem & { score: number }> = [];

    const ignoreResult = shouldRespectGitignore
      ? await buildIgnoreLookup(rootPath, spawn, resolveGitBinaryForSpawn, signal)
      : { lookup: null, status: "complete" as const };
    if (ignoreResult.status === "cancelled") {
      throw signal?.reason ?? Object.assign(new Error('File search aborted'), { name: 'AbortError' });
    }
    const ignore = ignoreResult.lookup;
    let enumerationStatus: FileSearchItems["enumerationStatus"] = ignoreResult.status === "failed" ? "failed" : "complete";
    if (requestedLimit !== null && enumerationStatus === "complete") enumerationStatus = "incomplete";

    while (queue.length > 0 && candidates.length < collectLimit) {
      if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('File search aborted'), { name: 'AbortError' });
      const batch = queue.splice(0, FILE_SEARCH_MAX_CONCURRENCY);

      const dirResults = await Promise.all(
        batch.map(async (dir) => ({ dir, ...(await listDirectoryEntries(dir, fsPromises)) })),
      );
      if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('File search aborted'), { name: 'AbortError' });

      for (const { dir: currentDir, entries, failed } of dirResults) {
        if (failed && enumerationStatus === "complete") enumerationStatus = "incomplete";
        for (const dirent of entries) {
          const entryName = dirent.name;
          if (!entryName || (!includeHiddenEntries && entryName.startsWith('.'))) {
            continue;
          }

          const entryPath = path.join(currentDir, entryName);
          const entryRelative = normalizeRelativeSearchPath(rootPath, entryPath, path);

          if (dirent.isDirectory()) {
            if (shouldSkipSearchDirectory(entryName, includeHiddenEntries)) {
              continue;
            }
            if (ignore && !ignore.allowsDirectory(entryRelative)) {
              continue;
            }
            if (!visited.has(entryPath)) {
              visited.add(entryPath);
              queue.push(entryPath);
            }
            continue;
          }

          if (!dirent.isFile()) {
            continue;
          }

          if (ignore && !ignore.allowsFile(entryRelative)) {
            continue;
          }

          const relativePath = entryRelative;
          const extension = entryName.includes('.') ? entryName.split('.').pop()?.toLowerCase() : undefined;

          if (matchAll) {
            candidates.push({
              name: entryName,
              path: entryPath,
              relativePath,
              ...(extension ? { extension } : {}),
              score: 0,
            });
          } else {
            const score = fuzzyMatchScoreNormalized(normalizedQuery, relativePath);
            if (score !== null) {
              candidates.push({
                name: entryName,
                path: entryPath,
                relativePath,
                ...(extension ? { extension } : {}),
                score,
              });
            }
          }

          if (candidates.length >= collectLimit) {
            queue.length = 0;
            break;
          }
        }

        if (candidates.length >= collectLimit) {
          break;
        }
      }
    }

    if (!matchAll) {
      candidates.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.relativePath.length !== b.relativePath.length) {
          return a.relativePath.length - b.relativePath.length;
        }
        return a.relativePath.localeCompare(b.relativePath);
      });
    }

    const selected = (requestedLimit === null ? candidates : candidates.slice(0, requestedLimit)).map(({ name, path: filePath, relativePath, extension }) => ({
      name,
      path: filePath,
      relativePath,
      ...(extension ? { extension } : {}),
    })) as FileSearchItems;
    Object.defineProperty(selected, "enumerationStatus", { value: enumerationStatus, enumerable: false });
    return selected;
  };

  return {
    isSearchableFile,
    searchFilesystemFiles,
  };
};
import type { Dirent } from 'node:fs';
import type { spawn as nodeSpawn } from 'node:child_process';
import type { FileSearchItem, FileSearchItems, FsPromises, PathModule } from './types.js';
