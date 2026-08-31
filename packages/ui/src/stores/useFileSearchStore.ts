import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import type { FileSearchResult } from '@piarium/application-client';
import { getRuntimeKey } from '@piarium/application-client';

const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 40;
const DEFAULT_SEARCH_LIMIT = 60;

interface FileSearchCacheEntry {
  files: PiariumFileSearchHit[];
  timestamp: number;
}

interface FileSearchStoreState {
  cache: Record<string, FileSearchCacheEntry>;
  cacheKeys: string[];
  inFlight: Record<string, Promise<PiariumFileSearchHit[]>>;
  searchFiles: (
    directory: string,
    query: string,
    limit?: number,
    options?: { includeHidden?: boolean; respectGitignore?: boolean; type?: 'file' | 'directory' }
  ) => Promise<PiariumFileSearchHit[]>;
  invalidateDirectory: (directory?: string | null) => void;
  resetForRuntimeSwitch: () => void;
}

export interface PiariumFileSearchHit {
  extension?: string;
  name: string;
  path: string;
  relativePath: string;
}

const normalizePath = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '');

const toRelativePath = (directory: string, result: FileSearchResult): string => {
  const preview = result.preview?.[0];
  if (typeof preview === 'string' && preview.trim()) return normalizePath(preview.trim()).replace(/^\/+/, '');
  const path = normalizePath(result.path);
  const root = normalizePath(directory);
  return path.toLocaleLowerCase().startsWith(`${root.toLocaleLowerCase()}/`)
    ? path.slice(root.length + 1)
    : path;
};

const toFileHit = (directory: string, result: FileSearchResult): PiariumFileSearchHit => {
  const path = normalizePath(result.path);
  const relativePath = toRelativePath(directory, result);
  const name = path.split('/').filter(Boolean).pop() || relativePath || path;
  return {
    name,
    path,
    relativePath,
    ...(name.includes('.') ? { extension: name.split('.').pop()?.toLowerCase() } : {}),
  };
};

const toDirectoryHits = (
  directory: string,
  results: FileSearchResult[],
  query: string,
  limit: number,
): PiariumFileSearchHit[] => {
  const root = normalizePath(directory);
  const normalizedQuery = query.toLocaleLowerCase();
  const hits = new Map<string, PiariumFileSearchHit>();
  for (const result of results) {
    const segments = toRelativePath(directory, result).split('/').filter(Boolean);
    segments.pop();
    for (let index = 1; index <= segments.length; index += 1) {
      const relativePath = segments.slice(0, index).join('/');
      if (normalizedQuery && !relativePath.toLocaleLowerCase().includes(normalizedQuery)) continue;
      const path = `${root}/${relativePath}`;
      hits.set(path.toLocaleLowerCase(), {
        name: segments[index - 1] ?? relativePath,
        path,
        relativePath,
      });
      if (hits.size >= limit) return [...hits.values()];
    }
  }
  return [...hits.values()];
};

const buildCacheKey = (
  runtimeKey: string,
  directory: string,
  query: string,
  limit: number,
  includeHidden: boolean,
  respectGitignore: boolean,
  type: 'file' | 'directory'
) => {
  const normalizedDirectory = directory.trim();
  const normalizedQuery = query.trim().toLowerCase();
  return JSON.stringify([runtimeKey, normalizedDirectory, normalizedQuery, limit, includeHidden, respectGitignore, type]);
};

const cacheKeyMatchesDirectory = (cacheKey: string, directory: string) => {
  try {
    const value: unknown = JSON.parse(cacheKey);
    return Array.isArray(value) && value[1] === directory;
  } catch {
    return false;
  }
};

export const useFileSearchStore = create<FileSearchStoreState>()(
  devtools(
    (set, get) => ({
      cache: {},
      cacheKeys: [],
      inFlight: {},
      async searchFiles(directory, query, limit = DEFAULT_SEARCH_LIMIT, options) {
        if (!directory || directory.trim().length === 0) {
          return [];
        }

        const normalizedDirectory = directory.trim();
        const runtimeKey = getRuntimeKey();
        const normalizedQuery = typeof query === 'string' ? query.trim() : '';
        const includeHidden = Boolean(options?.includeHidden);
        const respectGitignore = options?.respectGitignore ?? true;
        const type = options?.type === 'directory' ? 'directory' : 'file';
        const key = buildCacheKey(runtimeKey, normalizedDirectory, normalizedQuery, limit, includeHidden, respectGitignore, type);
        const now = Date.now();
        const cached = get().cache[key];

        if (cached && now - cached.timestamp < CACHE_TTL_MS) {
          return cached.files;
        }

        const inflight = get().inFlight[key];
        if (inflight) {
          return inflight;
        }

        const filesRuntime = getRegisteredRuntimeAPIs()?.files;
        if (!filesRuntime) throw new Error('Files runtime is unavailable');
        const searchPromise = filesRuntime
          .search({
            directory: normalizedDirectory,
            query: normalizedQuery,
            maxResults: type === 'directory' ? Math.max(limit * 4, limit) : limit,
            includeHidden,
            respectGitignore,
          })
          .then((results) => {
            const files = type === 'directory'
              ? toDirectoryHits(normalizedDirectory, results, normalizedQuery, limit)
              : results.map((result) => toFileHit(normalizedDirectory, result)).slice(0, limit);
            set((state) => {
              if (state.inFlight[key] !== searchPromise) {
                return state;
              }

              const nextCache = { ...state.cache, [key]: { files, timestamp: Date.now() } };
              const nextKeys = state.cacheKeys.filter((cacheKey) => cacheKey !== key);
              nextKeys.push(key);

              while (nextKeys.length > MAX_CACHE_ENTRIES) {
                const oldestKey = nextKeys.shift();
                if (oldestKey) {
                  delete nextCache[oldestKey];
                }
              }

              return {
                cache: nextCache,
                cacheKeys: nextKeys,
              };
            });
            return files;
          })
          .finally(() => {
            set((state) => {
              if (state.inFlight[key] !== searchPromise) {
                return state;
              }

              const nextInFlight = { ...state.inFlight };
              delete nextInFlight[key];
              return { inFlight: nextInFlight };
            });
          });

        set((state) => ({
          inFlight: {
            ...state.inFlight,
            [key]: searchPromise,
          },
        }));

        return searchPromise;
      },
      invalidateDirectory(directory) {
        if (!directory || directory.trim().length === 0) {
          set({ cache: {}, cacheKeys: [], inFlight: {} });
          return;
        }

        const normalizedDirectory = directory.trim();

        set((state) => {
          const nextCache = { ...state.cache };
          const nextKeys = state.cacheKeys.filter((cacheKey) => {
            if (cacheKeyMatchesDirectory(cacheKey, normalizedDirectory)) {
              delete nextCache[cacheKey];
              return false;
            }
            return true;
          });

          const nextInFlightEntries = Object.entries(state.inFlight).filter(
            ([key]) => !cacheKeyMatchesDirectory(key, normalizedDirectory)
          );
          const nextInFlight = Object.fromEntries(nextInFlightEntries);

          return {
            cache: nextCache,
            cacheKeys: nextKeys,
            inFlight: nextInFlight,
          };
        });
      },
      resetForRuntimeSwitch() {
        set({ cache: {}, cacheKeys: [], inFlight: {} });
      },
    }),
    {
      name: 'file-search-store',
    }
  )
);
