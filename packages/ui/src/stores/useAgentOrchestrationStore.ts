import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { startConfigUpdate, finishConfigUpdate } from '@/lib/configUpdate';
import { opencodeClient } from '@/lib/opencode/client';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { refreshAfterOpenCodeRestart } from '@/stores/useAgentsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { OpenAgentConfigResponse } from '@/stores/useOpenAgentConfigStore';
import type { SlimConfigResponse, SlimMode } from '@/components/sections/agent-orchestration/slimConfig';

export interface AgentOrchestrationConfigResponse {
  mode: {
    effective: SlimMode;
    user: SlimMode;
    project: SlimMode | null;
    conflicts: string[];
    configPaths: string[];
    tuiConfigPath: string | null;
    mtimeMsByPath: Record<string, number | null>;
  };
  activeProviderId: string | null;
  providerState: 'native' | 'active' | 'conflict';
  providers: Array<{
    id: string;
    legacyMode: Exclude<SlimMode, 'native' | 'conflict'> | null;
    title: string;
    description?: string | null;
    active: boolean;
    installed: boolean;
    configured?: boolean;
    configFileConfigured?: boolean;
    localPackageInstalled?: boolean;
    remembered?: boolean;
    managementSurfaceId?: string;
    expectedAgentName: string | null;
    known?: boolean;
    configurable?: boolean;
  }>;
  diagnostics: {
    conflicts: string[];
    configPaths: string[];
    tuiConfigPath: string | null;
    mtimeMsByPath: Record<string, number | null>;
  };
  omo: OpenAgentConfigResponse;
  slim: SlimConfigResponse;
}

type MutationResult = {
  ok: boolean;
  conflict?: boolean;
  reloadFailed?: boolean;
  message?: string;
};

interface AgentOrchestrationStore {
  config: AgentOrchestrationConfigResponse | null;
  isLoading: boolean;
  isSavingMode: boolean;
  error: string | null;
  loadConfig: (options?: { force?: boolean }) => Promise<boolean>;
  setMode: (mode: Exclude<SlimMode, 'conflict'>) => Promise<MutationResult>;
  setProvider: (providerId: string | null) => Promise<MutationResult>;
}

const CLIENT_RELOAD_DELAY_MS = 800;
const LOAD_CACHE_TTL_MS = 5000;
const DEFAULT_CACHE_KEY = '__default__';
const loadInFlight = new Map<string, Promise<boolean>>();
const lastLoadedAt = new Map<string, number>();

const getConfigDirectory = (): string | null => {
  try {
    const activeProject = useProjectsStore.getState().getActiveProject?.();
    if (activeProject?.path?.trim()) return activeProject.path.trim();
    const clientDir = opencodeClient.getDirectory();
    if (clientDir?.trim()) return clientDir.trim();
  } catch (error) {
    console.warn('[AgentOrchestrationStore] Error resolving config directory:', error);
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

const getExpectedAgentNameForMode = (mode: Exclude<SlimMode, 'conflict'>, config: AgentOrchestrationConfigResponse | null): string | undefined => {
  const provider = config?.providers.find((item) => item.legacyMode === mode);
  if (provider?.expectedAgentName) return provider.expectedAgentName;
  if (mode === 'native') return 'build';
  return undefined;
};

const getExpectedAgentNameForProvider = (providerId: string | null, config: AgentOrchestrationConfigResponse | null): string | undefined => {
  if (!providerId) return 'build';
  return config?.providers.find((item) => item.id === providerId)?.expectedAgentName ?? undefined;
};

export const useAgentOrchestrationStore = create<AgentOrchestrationStore>()(
  devtools(
    (set, get) => ({
      config: null,
      isLoading: false,
      isSavingMode: false,
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
            const response = await runtimeFetch('/api/agent-orchestration/config', {
              query: configDirectory ? { directory: configDirectory } : undefined,
              headers: configDirectory ? { 'x-opencode-directory': configDirectory } : undefined,
            });
            if (!response.ok) {
              throw new Error(await readApiError(response, 'Failed to load agent orchestration configuration'));
            }
            const config = await response.json() as AgentOrchestrationConfigResponse;
            set({ config, isLoading: false, error: null });
            lastLoadedAt.set(cacheKey, Date.now());
            return true;
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to load agent orchestration configuration';
            console.error('[AgentOrchestrationStore] Failed to load config:', error);
            set({ isLoading: false, error: message });
            return false;
          } finally {
            loadInFlight.delete(cacheKey);
          }
        })();

        loadInFlight.set(cacheKey, request);
        return request;
      },

      setMode: async (mode) => {
        const state = get();
        const configDirectory = getConfigDirectory();
        startConfigUpdate('Updating agent orchestration mode...');
        set({ isSavingMode: true, error: null });
        let requiresReload = false;
        try {
          const response = await runtimeFetch('/api/agent-orchestration/mode', {
            query: configDirectory ? { directory: configDirectory } : undefined,
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              ...(configDirectory ? { 'x-opencode-directory': configDirectory } : {}),
            },
            body: JSON.stringify({
              mode,
              expectedMtimeMsByPath: state.config?.mode.mtimeMsByPath ?? {},
            }),
          });
          const payload = await response.json().catch(() => null) as {
            config?: AgentOrchestrationConfigResponse;
            requiresReload?: boolean;
            reloadDelayMs?: number;
            reloadFailed?: boolean;
            message?: string;
            error?: string;
          } | null;

          if (!response.ok) {
            const message = payload?.error || 'Failed to update agent orchestration mode';
            const conflict = response.status === 409;
            set({ error: message, isSavingMode: false });
            return { ok: false, conflict, message };
          }

          if (payload?.config) set({ config: payload.config, error: null });
          invalidateCache(configDirectory);
          if (payload?.requiresReload) {
            requiresReload = true;
            await refreshAfterOpenCodeRestart({
              message: payload.message,
              delayMs: payload.reloadDelayMs ?? CLIENT_RELOAD_DELAY_MS,
              scopes: ['all'],
              mode: 'projects',
              expectedAgentName: getExpectedAgentNameForMode(mode, payload?.config ?? state.config),
            });
          }
          await get().loadConfig({ force: true });
          set({ isSavingMode: false });
          return { ok: true, reloadFailed: payload?.reloadFailed === true, message: payload?.message };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to update agent orchestration mode';
          console.error('[AgentOrchestrationStore] Failed to set mode:', error);
          set({ error: message, isSavingMode: false });
          return { ok: false, message };
        } finally {
          if (!requiresReload) finishConfigUpdate();
        }
      },

      setProvider: async (providerId) => {
        const state = get();
        const configDirectory = getConfigDirectory();
        startConfigUpdate('Updating agent orchestration provider...');
        set({ isSavingMode: true, error: null });
        let requiresReload = false;
        try {
          const response = await runtimeFetch('/api/agent-orchestration/provider', {
            query: configDirectory ? { directory: configDirectory } : undefined,
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              ...(configDirectory ? { 'x-opencode-directory': configDirectory } : {}),
            },
            body: JSON.stringify({
              providerId,
              expectedMtimeMsByPath: state.config?.mode.mtimeMsByPath ?? {},
            }),
          });
          const payload = await response.json().catch(() => null) as {
            config?: AgentOrchestrationConfigResponse;
            requiresReload?: boolean;
            reloadDelayMs?: number;
            reloadFailed?: boolean;
            message?: string;
            error?: string;
          } | null;

          if (!response.ok) {
            const message = payload?.error || 'Failed to update agent orchestration provider';
            const conflict = response.status === 409;
            set({ error: message, isSavingMode: false });
            return { ok: false, conflict, message };
          }

          if (payload?.config) set({ config: payload.config, error: null });
          invalidateCache(configDirectory);
          if (payload?.requiresReload) {
            requiresReload = true;
            await refreshAfterOpenCodeRestart({
              message: payload.message,
              delayMs: payload.reloadDelayMs ?? CLIENT_RELOAD_DELAY_MS,
              scopes: ['all'],
              mode: 'projects',
              expectedAgentName: getExpectedAgentNameForProvider(providerId, payload?.config ?? state.config),
            });
          }
          await get().loadConfig({ force: true });
          set({ isSavingMode: false });
          return { ok: true, reloadFailed: payload?.reloadFailed === true, message: payload?.message };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to update agent orchestration provider';
          console.error('[AgentOrchestrationStore] Failed to set provider:', error);
          set({ error: message, isSavingMode: false });
          return { ok: false, message };
        } finally {
          if (!requiresReload) finishConfigUpdate();
        }
      },

    }),
    { name: 'agent-orchestration-store' },
  ),
);
