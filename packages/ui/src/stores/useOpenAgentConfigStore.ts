import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { startConfigUpdate, finishConfigUpdate } from '@/lib/configUpdate';
import { opencodeClient } from '@/lib/opencode/client';
import {
  buildOpenAgentSavePayload,
  createOpenAgentDraftFromConfig,
  hasOpenAgentDraftChanges,
  type OpenAgentDraft,
  type OpenAgentKind,
  type OpenAgentOverride,
  type OpenAgentOverrideRecord,
} from '@/components/sections/openagent/openAgentConfig';
import { refreshAfterOpenCodeRestart } from '@/stores/useAgentsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { runtimeFetch } from '@/lib/runtime-fetch';

export interface OpenAgentConfigItem {
  id: string;
  label: string;
  description: string;
  group: 'main' | 'sub' | 'category' | 'custom';
  defaultModel: string | null;
  defaultVariant: string | null;
  override: OpenAgentOverride | null;
  projectOverride: boolean;
}

export interface OpenAgentConfigResponse {
  plugin: {
    detected: boolean;
    enabled?: boolean;
    entry: string | null;
    configPath: string | null;
    configKey?: 'plugin' | 'plugins';
    scope?: 'user' | 'project';
    writeTargetPath?: string | null;
    mtimeMs?: number | null;
  };
  target: {
    scope: 'user';
    path: string;
    exists: boolean;
    format: 'json' | 'jsonc';
    isLegacy?: boolean;
    legacyPath?: string | null;
    mtimeMs?: number | null;
  };
  project: {
    path: string | null;
    exists: boolean;
    overriddenAgents: string[];
    overriddenCategories: string[];
  };
  agents: OpenAgentConfigItem[];
  categories: OpenAgentConfigItem[];
  raw: {
    agents: OpenAgentOverrideRecord;
    categories: OpenAgentOverrideRecord;
    disabled_hooks?: string[];
    disabled_skills?: string[];
    disabled_commands?: string[];
    disabled_tools?: string[];
    disabled_mcps?: string[];
    disabled_providers?: string[];
    mcp_env_allowlist?: string[];
    default_mode?: string;
    hashline_edit?: boolean;
    model_fallback?: boolean;
    runtime_fallback?: unknown;
    background_task?: Record<string, unknown>;
    team_mode?: Record<string, unknown>;
    model_capabilities?: Record<string, unknown>;
    experimental?: Record<string, unknown>;
    skills?: Record<string, unknown>;
    tmux?: Record<string, unknown>;
  };
}

type OpenAgentMutationResult = {
  ok: boolean;
  conflict?: boolean;
  reloadFailed?: boolean;
  message?: string;
};

interface OpenAgentConfigStore {
  config: OpenAgentConfigResponse | null;
  initialDraft: OpenAgentDraft;
  draft: OpenAgentDraft;
  isLoading: boolean;
  isSaving: boolean;
  isPluginSaving: boolean;
  error: string | null;
  loadConfig: (options?: { force?: boolean }) => Promise<boolean>;
  setPluginEnabled: (enabled: boolean) => Promise<OpenAgentMutationResult>;
  updateDraft: (patch: Partial<OpenAgentDraft>) => void;
  updateDraftItem: (kind: OpenAgentKind, id: string, patch: Record<string, unknown>) => void;
  setDisabledHooks: (hooks: string[]) => void;
  resetItem: (kind: OpenAgentKind, id: string) => void;
  discardChanges: () => void;
  saveChanges: () => Promise<OpenAgentMutationResult>;
  hasChanges: () => boolean;
}

const CLIENT_RELOAD_DELAY_MS = 800;
const OPEN_AGENT_LOAD_CACHE_TTL_MS = 5000;
const DEFAULT_CACHE_KEY = '__default__';
const loadInFlight = new Map<string, Promise<boolean>>();
const lastLoadedAt = new Map<string, number>();

const emptyDraft = (): OpenAgentDraft => ({ agents: {}, categories: {}, disabled_hooks: [] });

const cloneDraft = (draft: OpenAgentDraft): OpenAgentDraft => JSON.parse(JSON.stringify(draft));

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
    console.warn('[OpenAgentConfigStore] Error resolving config directory:', error);
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

const setDraftRecord = (
  draft: OpenAgentDraft,
  kind: OpenAgentKind,
  updater: (record: OpenAgentOverrideRecord) => void,
) => {
  const record = kind === 'agent' ? draft.agents : draft.categories;
  updater(record);
};

export const useOpenAgentConfigStore = create<OpenAgentConfigStore>()(
  devtools(
    (set, get) => ({
      config: null,
      initialDraft: emptyDraft(),
      draft: emptyDraft(),
      isLoading: false,
      isSaving: false,
      isPluginSaving: false,
      error: null,

      loadConfig: async (options) => {
        const configDirectory = getConfigDirectory();
        const cacheKey = getCacheKey(configDirectory);
        const now = Date.now();
        const loadedAt = lastLoadedAt.get(cacheKey) ?? 0;
        const hasConfig = Boolean(get().config);

        if (!options?.force && hasConfig && now - loadedAt < OPEN_AGENT_LOAD_CACHE_TTL_MS) {
          return true;
        }

        const inFlight = loadInFlight.get(cacheKey);
        if (!options?.force && inFlight) {
          return inFlight;
        }

        const request = (async () => {
          set({ isLoading: true, error: null });
          try {
            const response = await runtimeFetch('/api/openagent/config', {
              query: configDirectory ? { directory: configDirectory } : undefined,
              headers: configDirectory ? { 'x-opencode-directory': configDirectory } : undefined,
            });
            if (!response.ok) {
              throw new Error(await readApiError(response, 'Failed to load Oh My OpenAgent configuration'));
            }

            const config = await response.json() as OpenAgentConfigResponse;
            const draft = createOpenAgentDraftFromConfig(config);
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
            const message = error instanceof Error ? error.message : 'Failed to load Oh My OpenAgent configuration';
            console.error('[OpenAgentConfigStore] Failed to load config:', error);
            set({ isLoading: false, error: message });
            return false;
          } finally {
            loadInFlight.delete(cacheKey);
          }
        })();

        loadInFlight.set(cacheKey, request);
        return request;
      },

      setPluginEnabled: async (enabled) => {
        const state = get();
        const configDirectory = getConfigDirectory();
        startConfigUpdate(enabled ? 'Enabling Oh My OpenAgent plugin...' : 'Disabling Oh My OpenAgent plugin...');
        set({ isPluginSaving: true, error: null });

        let requiresReload = false;
        try {
          const response = await runtimeFetch('/api/openagent/plugin', {
            query: configDirectory ? { directory: configDirectory } : undefined,
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              ...(configDirectory ? { 'x-opencode-directory': configDirectory } : {}),
            },
            body: JSON.stringify({
              enabled,
              expectedMtimeMs: state.config?.plugin.mtimeMs ?? null,
              entry: state.config?.plugin.entry ?? undefined,
            }),
          });

          const responsePayload = await response.json().catch(() => null) as {
            config?: OpenAgentConfigResponse;
            requiresReload?: boolean;
            reloadDelayMs?: number;
            reloadFailed?: boolean;
            message?: string;
            error?: string;
          } | null;

          if (!response.ok) {
            const message = responsePayload?.error || 'Failed to update Oh My OpenAgent plugin';
            const conflict = response.status === 409;
            set({ error: message, isPluginSaving: false });
            return { ok: false, conflict, message };
          }

          if (responsePayload?.config) {
            const nextDraft = createOpenAgentDraftFromConfig(responsePayload.config);
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
          set({ isPluginSaving: false });

          return {
            ok: true,
            reloadFailed: responsePayload?.reloadFailed === true,
            message: responsePayload?.message,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to update Oh My OpenAgent plugin';
          console.error('[OpenAgentConfigStore] Failed to update plugin:', error);
          set({ error: message, isPluginSaving: false });
          return { ok: false, message };
        } finally {
          if (!requiresReload) {
            finishConfigUpdate();
          }
        }
      },

      updateDraft: (patch) => {
        set((state) => {
          const draft = cloneDraft(state.draft);
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined) {
              delete draft[key as keyof OpenAgentDraft];
            } else {
              (draft as unknown as Record<string, unknown>)[key] = value;
            }
          }
          return { draft, error: null };
        });
      },

      updateDraftItem: (kind, id, patch) => {
        const key = id.trim();
        if (!key) return;

        set((state) => {
          const draft = cloneDraft(state.draft);
          setDraftRecord(draft, kind, (record) => {
            const next = { ...(record[key] ?? {}) };
            for (const [field, value] of Object.entries(patch)) {
              if (value === undefined) {
                delete next[field];
              } else {
                next[field] = value;
              }
            }
            if (Object.keys(next).length === 0) {
              delete record[key];
            } else {
              record[key] = next;
            }
          });

          return { draft, error: null };
        });
      },

      setDisabledHooks: (hooks) => {
        set({
          draft: {
            ...get().draft,
            disabled_hooks: Array.from(new Set(hooks.map((hook) => hook.trim()).filter(Boolean))).sort(),
          },
          error: null,
        });
      },

      resetItem: (kind, id) => {
        const key = id.trim();
        if (!key) return;

        set((state) => {
          const draft = cloneDraft(state.draft);
          setDraftRecord(draft, kind, (record) => {
            delete record[key];
          });
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
        if (!hasOpenAgentDraftChanges(state.initialDraft, state.draft)) {
          return { ok: true };
        }

        const configDirectory = getConfigDirectory();
        startConfigUpdate('Saving Oh My OpenAgent configuration...');
        set({ isSaving: true, error: null });

        let requiresReload = false;
        try {
          const payload = buildOpenAgentSavePayload(state.config?.target.mtimeMs ?? null, state.draft);
          const response = await runtimeFetch('/api/openagent/config', {
            query: configDirectory ? { directory: configDirectory } : undefined,
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              ...(configDirectory ? { 'x-opencode-directory': configDirectory } : {}),
            },
            body: JSON.stringify(payload),
          });

          const responsePayload = await response.json().catch(() => null) as {
            config?: OpenAgentConfigResponse;
            requiresReload?: boolean;
            reloadDelayMs?: number;
            reloadFailed?: boolean;
            message?: string;
            error?: string;
          } | null;

          if (!response.ok) {
            const message = responsePayload?.error || 'Failed to save Oh My OpenAgent configuration';
            const conflict = response.status === 409;
            set({ error: message, isSaving: false });
            return { ok: false, conflict, message };
          }

          if (responsePayload?.config) {
            const nextDraft = createOpenAgentDraftFromConfig(responsePayload.config);
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
          const message = error instanceof Error ? error.message : 'Failed to save Oh My OpenAgent configuration';
          console.error('[OpenAgentConfigStore] Failed to save config:', error);
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
        return hasOpenAgentDraftChanges(state.initialDraft, state.draft);
      },
    }),
    { name: 'openagent-config-store' },
  ),
);
