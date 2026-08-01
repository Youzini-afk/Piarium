import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { startConfigUpdate, finishConfigUpdate } from '@/lib/configUpdate';
import { opencodeClient } from '@/lib/opencode/client';
import {
  buildMagicContextSavePayload,
  createMagicContextDraftFromConfig,
  hasMagicContextDraftChanges,
  type MagicContextConfig,
  type MagicContextConfigSourceLike,
} from '@/components/sections/magic-context/magicContextConfig';
import { refreshAfterOpenCodeRestart } from '@/stores/useAgentsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { runtimeFetch } from '@/lib/runtime-fetch';

export interface MagicContextConfigResponse {
  plugin: {
    detected: boolean;
    entry: string | null;
    configPath: string | null;
  };
  target: {
    scope: 'user';
    path: string;
    exists: boolean;
    format: 'json' | 'jsonc';
    mtimeMs?: number | null;
  };
  source?: MagicContextConfigSourceLike | null;
  project: {
    path: string | null;
    exists: boolean;
    overriddenKeys: string[];
    source?: MagicContextConfigSourceLike | null;
    legacy?: boolean;
  };
  diagnostics?: {
    tui?: {
      detected: boolean;
      entry: string | null;
      configPath: string | null;
    };
    omo?: {
      detected: boolean;
      activeConflictingHooks: string[];
      disabledConflictingHooks: string[];
    };
    configPath?: {
      uiConfigDir: string;
      runtimeConfigDir: string;
      matchesRuntime: boolean;
      legacyConfigDir?: string;
    };
    source?: (MagicContextConfigSourceLike & {
      targetPath?: string | null;
      differsFromTarget?: boolean;
    }) | null;
    project?: {
      ignoredUserOnlyKeys: string[];
      source?: MagicContextConfigSourceLike | null;
      legacy?: boolean;
    };
  };
  schemaUrl: string;
  raw: MagicContextConfig;
  projectRaw: MagicContextConfig;
}

type MagicContextMutationResult = {
  ok: boolean;
  conflict?: boolean;
  reloadFailed?: boolean;
  message?: string;
};

type DraftPath = Array<string | number>;

interface MagicContextConfigStore {
  config: MagicContextConfigResponse | null;
  initialDraft: MagicContextConfig;
  draft: MagicContextConfig;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  loadConfig: (options?: { force?: boolean }) => Promise<boolean>;
  updateDraft: (patch: Record<string, unknown>) => void;
  updateDraftPath: (path: DraftPath, value: unknown) => void;
  resetKey: (key: string) => void;
  discardChanges: () => void;
  saveChanges: () => Promise<MagicContextMutationResult>;
  hasChanges: () => boolean;
}

const CLIENT_RELOAD_DELAY_MS = 800;
const LOAD_CACHE_TTL_MS = 5000;
const DEFAULT_CACHE_KEY = '__default__';
const loadInFlight = new Map<string, Promise<boolean>>();
const lastLoadedAt = new Map<string, number>();

const emptyDraft = (): MagicContextConfig => ({});
const cloneDraft = (draft: MagicContextConfig): MagicContextConfig => JSON.parse(JSON.stringify(draft ?? {}));

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const getConfigDirectory = (): string | null => {
  try {
    const activeProject = useProjectsStore.getState().getActiveProject?.();
    if (activeProject?.path?.trim()) {
      return activeProject.path.trim();
    }

    const clientDir = opencodeClient.getDirectory();
    if (clientDir?.trim()) {
      return clientDir.trim();
    }
  } catch (error) {
    console.warn('[MagicContextConfigStore] Error resolving config directory:', error);
  }
  return null;
};

const getCacheKey = (directory: string | null): string => directory?.trim() || DEFAULT_CACHE_KEY;

const invalidateCache = (directory: string | null) => {
  lastLoadedAt.delete(getCacheKey(directory));
};

const readApiError = async (response: Response, fallback: string): Promise<string> => {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof payload?.error === 'string' && payload.error.trim() ? payload.error : fallback;
};

const applyPathUpdate = (
  root: Record<string, unknown>,
  path: DraftPath,
  value: unknown,
) => {
  if (path.length === 0) return;

  let current = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = String(path[index]);
    const nextValue = current[key];
    if (!isPlainObject(nextValue)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  const finalKey = String(path[path.length - 1]);
  if (value === undefined) {
    delete current[finalKey];
  } else {
    current[finalKey] = value;
  }
};

export const useMagicContextConfigStore = create<MagicContextConfigStore>()(
  devtools(
    (set, get) => ({
      config: null,
      initialDraft: emptyDraft(),
      draft: emptyDraft(),
      isLoading: false,
      isSaving: false,
      error: null,

      loadConfig: async (options) => {
        const configDirectory = getConfigDirectory();
        const cacheKey = getCacheKey(configDirectory);
        const now = Date.now();
        const loadedAt = lastLoadedAt.get(cacheKey) ?? 0;
        const hasConfig = Boolean(get().config);

        if (!options?.force && hasConfig && now - loadedAt < LOAD_CACHE_TTL_MS) {
          return true;
        }

        const inFlight = loadInFlight.get(cacheKey);
        if (!options?.force && inFlight) {
          return inFlight;
        }

        const request = (async () => {
          set({ isLoading: true, error: null });
          try {
            const response = await runtimeFetch('/api/magic-context/config', {
              query: configDirectory ? { directory: configDirectory } : undefined,
              headers: configDirectory ? { 'x-opencode-directory': configDirectory } : undefined,
            });
            if (!response.ok) {
              throw new Error(await readApiError(response, 'Failed to load Magic Context configuration'));
            }

            const config = await response.json() as MagicContextConfigResponse;
            const draft = createMagicContextDraftFromConfig(config);
            set({
              config,
              initialDraft: cloneDraft(draft),
              draft,
              isLoading: false,
              error: null,
            });
            lastLoadedAt.set(cacheKey, Date.now());
            return true;
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to load Magic Context configuration';
            console.error('[MagicContextConfigStore] Failed to load config:', error);
            set({ isLoading: false, error: message });
            return false;
          } finally {
            loadInFlight.delete(cacheKey);
          }
        })();

        loadInFlight.set(cacheKey, request);
        return request;
      },

      updateDraft: (patch) => {
        set((state) => {
          const draft = cloneDraft(state.draft);
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined) {
              delete draft[key];
            } else {
              draft[key] = value;
            }
          }
          return { draft, error: null };
        });
      },

      updateDraftPath: (path, value) => {
        set((state) => {
          const draft = cloneDraft(state.draft);
          applyPathUpdate(draft, path, value);
          return { draft, error: null };
        });
      },

      resetKey: (key) => {
        const normalizedKey = key.trim();
        if (!normalizedKey) return;
        set((state) => {
          const draft = cloneDraft(state.draft);
          draft[normalizedKey] = {};
          return { draft, error: null };
        });
      },

      discardChanges: () => {
        set((state) => ({
          draft: cloneDraft(state.initialDraft),
          error: null,
        }));
      },

      saveChanges: async () => {
        const state = get();
        if (!hasMagicContextDraftChanges(state.initialDraft, state.draft)) {
          return { ok: true };
        }

        const configDirectory = getConfigDirectory();
        startConfigUpdate('Saving Magic Context configuration...');
        set({ isSaving: true, error: null });

        let requiresReload = false;
        try {
          const payload = buildMagicContextSavePayload(state.config?.target.mtimeMs ?? null, state.draft, state.config?.source ?? null);
          const response = await runtimeFetch('/api/magic-context/config', {
            query: configDirectory ? { directory: configDirectory } : undefined,
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              ...(configDirectory ? { 'x-opencode-directory': configDirectory } : {}),
            },
            body: JSON.stringify(payload),
          });

          const responsePayload = await response.json().catch(() => null) as {
            config?: MagicContextConfigResponse;
            requiresReload?: boolean;
            reloadDelayMs?: number;
            reloadFailed?: boolean;
            message?: string;
            error?: string;
          } | null;

          if (!response.ok) {
            const message = responsePayload?.error || 'Failed to save Magic Context configuration';
            const conflict = response.status === 409;
            set({ error: message, isSaving: false });
            return { ok: false, conflict, message };
          }

          if (responsePayload?.config) {
            const nextDraft = createMagicContextDraftFromConfig(responsePayload.config);
            set({
              config: responsePayload.config,
              initialDraft: cloneDraft(nextDraft),
              draft: nextDraft,
              error: null,
            });
          }

          invalidateCache(configDirectory);

          if (responsePayload?.requiresReload) {
            requiresReload = true;
            await refreshAfterOpenCodeRestart({
              message: responsePayload.message,
              delayMs: responsePayload.reloadDelayMs ?? CLIENT_RELOAD_DELAY_MS,
              scopes: ['all'],
              mode: 'projects',
            });
          }

          await get().loadConfig({ force: true });
          set({ isSaving: false });

          return {
            ok: true,
            reloadFailed: responsePayload?.reloadFailed === true,
            message: responsePayload?.message,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to save Magic Context configuration';
          console.error('[MagicContextConfigStore] Failed to save config:', error);
          set({ error: message, isSaving: false });
          return { ok: false, message };
        } finally {
          if (!requiresReload) {
            finishConfigUpdate();
          }
        }
      },

      hasChanges: () => {
        const state = get();
        return hasMagicContextDraftChanges(state.initialDraft, state.draft);
      },
    }),
    { name: 'magic-context-config-store' },
  ),
);
