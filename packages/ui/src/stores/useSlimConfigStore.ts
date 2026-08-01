import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { startConfigUpdate, finishConfigUpdate } from '@/lib/configUpdate';
import { opencodeClient } from '@/lib/opencode/client';
import { refreshAfterOpenCodeRestart } from '@/stores/useAgentsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  buildSlimSavePayload,
  createSlimDraftFromConfig,
  getActivePreset,
  hasSlimDraftChanges,
  type SlimAgentOverride,
  type SlimConfigResponse,
  type SlimRawConfig,
} from '@/components/sections/agent-orchestration/slimConfig';

type MutationResult = {
  ok: boolean;
  conflict?: boolean;
  reloadFailed?: boolean;
  message?: string;
};

type DraftPath = Array<string | number>;

interface SlimConfigStore {
  config: SlimConfigResponse | null;
  initialDraft: SlimRawConfig;
  draft: SlimRawConfig;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  loadConfig: (options?: { force?: boolean }) => Promise<boolean>;
  updateDraftPath: (path: DraftPath, value: unknown) => void;
  updatePresetAgent: (agentId: string, patch: SlimAgentOverride) => void;
  setAgentDisabled: (agentId: string, disabled: boolean) => void;
  discardChanges: () => void;
  saveChanges: () => Promise<MutationResult>;
  hasChanges: () => boolean;
}

const CLIENT_RELOAD_DELAY_MS = 800;
const LOAD_CACHE_TTL_MS = 5000;
const DEFAULT_CACHE_KEY = '__default__';
const loadInFlight = new Map<string, Promise<boolean>>();
const lastLoadedAt = new Map<string, number>();

const emptyDraft = (): SlimRawConfig => ({});
const cloneDraft = (draft: SlimRawConfig): SlimRawConfig => JSON.parse(JSON.stringify(draft ?? {}));

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const getConfigDirectory = (): string | null => {
  try {
    const activeProject = useProjectsStore.getState().getActiveProject?.();
    if (activeProject?.path?.trim()) return activeProject.path.trim();
    const clientDir = opencodeClient.getDirectory();
    if (clientDir?.trim()) return clientDir.trim();
  } catch (error) {
    console.warn('[SlimConfigStore] Error resolving config directory:', error);
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

const applyPathUpdate = (root: Record<string, unknown>, path: DraftPath, value: unknown) => {
  if (path.length === 0) return;
  let current = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = String(path[index]);
    const nextValue = current[key];
    if (!isPlainObject(nextValue)) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  const finalKey = String(path[path.length - 1]);
  if (value === undefined) {
    delete current[finalKey];
  } else {
    current[finalKey] = value;
  }
};

export const useSlimConfigStore = create<SlimConfigStore>()(
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
        if (!options?.force && hasConfig && now - loadedAt < LOAD_CACHE_TTL_MS) return true;
        const inFlight = loadInFlight.get(cacheKey);
        if (!options?.force && inFlight) return inFlight;

        const request = (async () => {
          set({ isLoading: true, error: null });
          try {
            const response = await runtimeFetch('/api/agent-orchestration/slim/config', {
              query: configDirectory ? { directory: configDirectory } : undefined,
              headers: configDirectory ? { 'x-opencode-directory': configDirectory } : undefined,
            });
            if (!response.ok) {
              throw new Error(await readApiError(response, 'Failed to load Slim configuration'));
            }
            const config = await response.json() as SlimConfigResponse;
            const draft = createSlimDraftFromConfig(config);
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
            const message = error instanceof Error ? error.message : 'Failed to load Slim configuration';
            console.error('[SlimConfigStore] Failed to load config:', error);
            set({ isLoading: false, error: message });
            return false;
          } finally {
            loadInFlight.delete(cacheKey);
          }
        })();

        loadInFlight.set(cacheKey, request);
        return request;
      },

      updateDraftPath: (path, value) => {
        set((state) => {
          const draft = cloneDraft(state.draft);
          applyPathUpdate(draft, path, value);
          return { draft, error: null };
        });
      },

      updatePresetAgent: (agentId, patch) => {
        const id = agentId.trim();
        if (!id) return;
        set((state) => {
          const draft = cloneDraft(state.draft);
          const preset = getActivePreset(draft);
          if (!isPlainObject(draft.presets)) draft.presets = {};
          if (!isPlainObject(draft.presets[preset])) draft.presets[preset] = {};
          const current = isPlainObject(draft.presets[preset][id]) ? draft.presets[preset][id] : {};
          const next: SlimAgentOverride = { ...current };
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined || value === '') {
              delete next[key];
            } else {
              next[key] = value;
            }
          }
          if (Object.keys(next).length === 0) {
            delete draft.presets[preset][id];
          } else {
            draft.presets[preset][id] = next;
          }
          return { draft, error: null };
        });
      },

      setAgentDisabled: (agentId, disabled) => {
        const id = agentId.trim();
        if (!id || id === 'orchestrator' || id === 'councillor') return;
        set((state) => {
          const draft = cloneDraft(state.draft);
          const current = Array.isArray(draft.disabled_agents) ? draft.disabled_agents : [];
          const setIds = new Set(current.map((entry) => String(entry).trim()).filter(Boolean));
          if (disabled) setIds.add(id);
          else setIds.delete(id);
          draft.disabled_agents = Array.from(setIds).sort();
          return { draft, error: null };
        });
      },

      discardChanges: () => {
        set((state) => ({ draft: cloneDraft(state.initialDraft), error: null }));
      },

      saveChanges: async () => {
        const state = get();
        if (!hasSlimDraftChanges(state.initialDraft, state.draft)) return { ok: true };
        const configDirectory = getConfigDirectory();
        startConfigUpdate('Saving Slim configuration...');
        set({ isSaving: true, error: null });
        let requiresReload = false;
        try {
          const payload = buildSlimSavePayload(state.config?.target.mtimeMs ?? null, state.draft);
          const response = await runtimeFetch('/api/agent-orchestration/slim/config', {
            query: configDirectory ? { directory: configDirectory } : undefined,
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              ...(configDirectory ? { 'x-opencode-directory': configDirectory } : {}),
            },
            body: JSON.stringify(payload),
          });
          const responsePayload = await response.json().catch(() => null) as {
            config?: SlimConfigResponse;
            requiresReload?: boolean;
            reloadDelayMs?: number;
            reloadFailed?: boolean;
            message?: string;
            error?: string;
          } | null;
          if (!response.ok) {
            const message = responsePayload?.error || 'Failed to save Slim configuration';
            const conflict = response.status === 409;
            set({ error: message, isSaving: false });
            return { ok: false, conflict, message };
          }
          if (responsePayload?.config) {
            const nextDraft = createSlimDraftFromConfig(responsePayload.config);
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
          return { ok: true, reloadFailed: responsePayload?.reloadFailed === true, message: responsePayload?.message };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to save Slim configuration';
          console.error('[SlimConfigStore] Failed to save config:', error);
          set({ error: message, isSaving: false });
          return { ok: false, message };
        } finally {
          if (!requiresReload) finishConfigUpdate();
        }
      },

      hasChanges: () => {
        const state = get();
        return hasSlimDraftChanges(state.initialDraft, state.draft);
      },
    }),
    { name: 'slim-config-store' },
  ),
);
