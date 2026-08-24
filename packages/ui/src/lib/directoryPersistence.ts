import type { RuntimeAPIs } from '@/lib/api/types';
import { isDesktopLocalOriginActive, isVSCodeRuntime } from '@/lib/desktop';
import {
  resolveRuntimeWorkspaceRoot,
  resolveWorkspaceAwareRestoredDirectory,
} from '@/lib/defaultDirectory';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';

const safeStorage = getDeferredSafeStorage();

const readSavedDirectory = (): string | null => {
  const value = safeStorage.getItem('lastDirectory');
  return typeof value === 'string' && value.trim() ? value : null;
};

export const applyPersistedDirectoryPreferences = async (
  apis?: RuntimeAPIs,
  options: { ignorePersistedDirectory?: string | null } = {},
): Promise<void> => {
  if (typeof window === 'undefined') {
    return;
  }

  const runtimeKey = getRuntimeKey();
  const observedDirectory = readSavedDirectory();
  const ignoredDirectory = options.ignorePersistedDirectory?.trim() || null;
  const savedDirectory = observedDirectory === ignoredDirectory ? null : observedDirectory;

  // Home directory is intentionally NOT restored from localStorage here.
  // The persisted value is only a boot-time cache already consumed by the
  // directory store's initial state; replaying it through
  // synchronizeHomeDirectory would persist a possibly stale value back into
  // desktop settings, overriding the authoritative resolution
  // (initializeHomeDirectory → /api/fs/home) that runs on every startup.

  if (isVSCodeRuntime()) return;

  let workspaceRoot: string | null = null;
  if (apis) {
    try {
      workspaceRoot = await resolveRuntimeWorkspaceRoot(apis, {
        desktopLocal: isDesktopLocalOriginActive(),
      });
    } catch (error) {
      console.warn('Failed to resolve the runtime workspace root:', error);
    }
  }

  if (getRuntimeKey() !== runtimeKey) return;

  const directoryState = useDirectoryStore.getState();
  const hasSelectedWorkspace = useProjectsStore.getState().activeProjectId !== null;
  const nextDirectory = resolveWorkspaceAwareRestoredDirectory({
    hasSelectedWorkspace,
    homeDirectory: directoryState.homeDirectory,
    latestPersistedDirectory: readSavedDirectory(),
    persistedDirectory: savedDirectory,
    workspaceRoot,
  });
  if (nextDirectory && nextDirectory !== directoryState.currentDirectory) {
    directoryState.setDirectory(nextDirectory, { showOverlay: false });
  }
};

export const waitForRuntimeSettingsSync = (
  windowObject: Pick<Window, 'addEventListener' | 'clearTimeout' | 'removeEventListener' | 'setTimeout'>,
  timeoutMs = 10_000,
): Promise<boolean> => new Promise((resolve) => {
  let settled = false;
  const finish = (synced: boolean) => {
    if (settled) return;
    settled = true;
    windowObject.clearTimeout(timeout);
    windowObject.removeEventListener('piarium:settings-synced', handleSettingsSynced);
    resolve(synced);
  };
  const handleSettingsSynced = () => finish(true);
  windowObject.addEventListener('piarium:settings-synced', handleSettingsSynced, { once: true });
  const timeout = windowObject.setTimeout(() => finish(false), timeoutMs);
});

export const subscribeDefaultDirectoryToRuntimeChanges = (apis: RuntimeAPIs): (() => void) => (
  subscribeRuntimeEndpointChanged((detail) => {
    // LAN/relay transport swaps for the same runtime keep the same filesystem
    // authority, so they must not reset the user's active project directory.
    if (detail.runtimeKey === detail.previousRuntimeKey) return;
    const previousPersistedDirectory = readSavedDirectory();
    queueMicrotask(() => void (async () => {
      const settingsSynced = await waitForRuntimeSettingsSync(window);
      if (getRuntimeKey() !== detail.runtimeKey) return;
      await applyPersistedDirectoryPreferences(apis, {
        ignorePersistedDirectory: settingsSynced ? null : previousPersistedDirectory,
      });
    })());
  })
);
