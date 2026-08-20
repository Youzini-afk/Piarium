import { PIARIUM_WORKBENCH_IDE_PROFILE_ID } from '@piarium/extension-contract';
import { getRuntimeKey } from '@/lib/runtime-switch';

const IDE_WORKBENCH_LAYOUT_VERSION = 1 as const;

export type IdeWorkbenchActivityId = 'explorer' | 'search' | 'git' | 'run' | 'extensions';
export type IdeWorkbenchSecondaryId = 'agent' | 'context' | 'fleet' | 'recovery';

export interface IdeWorkbenchLayoutState {
  activity: IdeWorkbenchActivityId;
  primaryVisible: boolean;
  primaryWidth: number;
  secondaryVisible: boolean;
  secondaryView: IdeWorkbenchSecondaryId;
  secondaryWidth: number;
}

type IdeWorkbenchLayoutRestoreResult =
  | { status: 'missing' | 'empty' | 'malformed' }
  | { status: 'failure'; errorMessage: string }
  | { status: 'ready'; state: IdeWorkbenchLayoutState };

type PersistBackend = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const ACTIVITIES = new Set<IdeWorkbenchActivityId>(['explorer', 'search', 'git', 'run', 'extensions']);
const SECONDARY = new Set<IdeWorkbenchSecondaryId>(['agent', 'context', 'fleet', 'recovery']);
const memory = new Map<string, string>();
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastGood = new Map<string, IdeWorkbenchLayoutState>();
let backendOverride: PersistBackend | undefined;

export const DEFAULT_IDE_WORKBENCH_LAYOUT: IdeWorkbenchLayoutState = {
  activity: 'explorer',
  primaryVisible: true,
  primaryWidth: 280,
  secondaryVisible: true,
  secondaryView: 'agent',
  secondaryWidth: 380,
};

const isObject = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const clampWidth = (value: number, min: number, max: number): number => (
  Math.min(max, Math.max(min, Math.round(value)))
);

const normalizeIdeWorkbenchLayout = (
  value: Partial<IdeWorkbenchLayoutState> | IdeWorkbenchLayoutState,
): IdeWorkbenchLayoutState => ({
  activity: ACTIVITIES.has(value.activity as IdeWorkbenchActivityId)
    ? value.activity as IdeWorkbenchActivityId
    : DEFAULT_IDE_WORKBENCH_LAYOUT.activity,
  primaryVisible: value.primaryVisible !== false,
  primaryWidth: clampWidth(
    typeof value.primaryWidth === 'number' ? value.primaryWidth : DEFAULT_IDE_WORKBENCH_LAYOUT.primaryWidth,
    180,
    520,
  ),
  secondaryVisible: value.secondaryVisible !== false,
  secondaryView: SECONDARY.has(value.secondaryView as IdeWorkbenchSecondaryId)
    ? value.secondaryView as IdeWorkbenchSecondaryId
    : DEFAULT_IDE_WORKBENCH_LAYOUT.secondaryView,
  secondaryWidth: clampWidth(
    typeof value.secondaryWidth === 'number' ? value.secondaryWidth : DEFAULT_IDE_WORKBENCH_LAYOUT.secondaryWidth,
    240,
    640,
  ),
});

const defaultBackend = (): PersistBackend => {
  if (backendOverride) return backendOverride;
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // Restricted storage falls back to memory.
  }
  return {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value);
    },
    removeItem: (key) => {
      memory.delete(key);
    },
  };
};

export const setIdeWorkbenchLayoutPersistBackendForTests = (backend?: PersistBackend): void => {
  backendOverride = backend;
};

export const ideWorkbenchLayoutPersistKey = (
  workspaceId: string,
  runtimeKey = getRuntimeKey(),
  profileId = PIARIUM_WORKBENCH_IDE_PROFILE_ID,
): string => `piarium.ide-workbench:${runtimeKey}:${profileId}:${workspaceId}`;

export const rememberLastGoodIdeWorkbenchLayout = (workspaceId: string, state: IdeWorkbenchLayoutState): void => {
  lastGood.set(workspaceId, state);
};

const restoreIdeWorkbenchLayoutSnapshot = (raw: unknown): IdeWorkbenchLayoutRestoreResult => {
  if (raw === undefined || raw === null) return { status: 'missing' };
  if (raw === '') return { status: 'empty' };
  try {
    const payload = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
    if (!isObject(payload) || payload.version !== IDE_WORKBENCH_LAYOUT_VERSION || !isObject(payload.state)) {
      return { status: 'malformed' };
    }
    return { status: 'ready', state: normalizeIdeWorkbenchLayout(payload.state) };
  } catch (error) {
    return {
      status: 'failure',
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
};

const readPersistedIdeWorkbenchLayout = (workspaceId: string): IdeWorkbenchLayoutRestoreResult => {
  try {
    return restoreIdeWorkbenchLayoutSnapshot(defaultBackend().getItem(ideWorkbenchLayoutPersistKey(workspaceId)));
  } catch (error) {
    return {
      status: 'failure',
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
};

export const writePersistedIdeWorkbenchLayout = (workspaceId: string, state: IdeWorkbenchLayoutState): void => {
  const normalized = normalizeIdeWorkbenchLayout(state);
  rememberLastGoodIdeWorkbenchLayout(workspaceId, normalized);
  try {
    defaultBackend().setItem(ideWorkbenchLayoutPersistKey(workspaceId), JSON.stringify({
      version: IDE_WORKBENCH_LAYOUT_VERSION,
      state: normalized,
    }));
  } catch {
    // Keep last-good in memory; a failed write must not clear it.
  }
};

export const schedulePersistedIdeWorkbenchLayout = (workspaceId: string, state: IdeWorkbenchLayoutState): void => {
  rememberLastGoodIdeWorkbenchLayout(workspaceId, normalizeIdeWorkbenchLayout(state));
  const existing = persistTimers.get(workspaceId);
  if (existing) clearTimeout(existing);
  persistTimers.set(workspaceId, setTimeout(() => {
    persistTimers.delete(workspaceId);
    const next = lastGood.get(workspaceId);
    if (next) writePersistedIdeWorkbenchLayout(workspaceId, next);
  }, 400));
};

export const flushPersistedIdeWorkbenchLayout = (workspaceId?: string): void => {
  if (workspaceId) {
    const timer = persistTimers.get(workspaceId);
    if (timer) {
      clearTimeout(timer);
      persistTimers.delete(workspaceId);
    }
    const state = lastGood.get(workspaceId);
    if (state) writePersistedIdeWorkbenchLayout(workspaceId, state);
    return;
  }
  for (const [id, timer] of persistTimers) {
    clearTimeout(timer);
    persistTimers.delete(id);
    const state = lastGood.get(id);
    if (state) writePersistedIdeWorkbenchLayout(id, state);
  }
};

export const lastGoodIdeWorkbenchLayout = (workspaceId: string): IdeWorkbenchLayoutState | undefined => (
  lastGood.get(workspaceId)
);

export const hydrateIdeWorkbenchLayout = (workspaceId: string): IdeWorkbenchLayoutState => {
  const restored = readPersistedIdeWorkbenchLayout(workspaceId);
  if (restored.status === 'ready') {
    rememberLastGoodIdeWorkbenchLayout(workspaceId, restored.state);
    return restored.state;
  }
  const previous = lastGood.get(workspaceId);
  if (previous && (restored.status === 'failure' || restored.status === 'malformed')) {
    return previous;
  }
  return DEFAULT_IDE_WORKBENCH_LAYOUT;
};

export const resetIdeWorkbenchLayoutForRuntimeSwitch = (): void => {
  for (const timer of persistTimers.values()) clearTimeout(timer);
  persistTimers.clear();
  lastGood.clear();
  memory.clear();
};

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => flushPersistedIdeWorkbenchLayout(), { capture: true });
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushPersistedIdeWorkbenchLayout();
    });
    document.addEventListener('freeze', () => flushPersistedIdeWorkbenchLayout());
  }
}
