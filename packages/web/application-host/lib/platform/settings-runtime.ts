import {
  createSettingsFileStore,
  type PiariumSettingsDocument,
  type SettingsFileStore,
  type SettingsFileStoreOptions,
} from '@piarium/settings-store';

interface ProjectEntry extends Record<string, unknown> {
  id: string;
  path: string;
}

interface ManagedTunnelPreset {
  hostname: string;
  id: string;
  name: string;
}

interface ManagedTunnelTokenUpdate extends ManagedTunnelPreset {
  token: string;
}

export interface SettingsRuntimeDependencies {
  SETTINGS_FILE_PATH: string;
  formatSettingsResponse(settings: PiariumSettingsDocument): PiariumSettingsDocument;
  fsPromises: NonNullable<SettingsFileStoreOptions['fsPromises']>;
  mergePersistedSettings(
    current: PiariumSettingsDocument,
    changes: PiariumSettingsDocument,
  ): PiariumSettingsDocument;
  normalizeSettingsPaths(settings: PiariumSettingsDocument): {
    changed: boolean;
    settings: PiariumSettingsDocument;
  };
  path: NonNullable<SettingsFileStoreOptions['pathModule']>;
  sanitizeProjects?: ((projects: unknown) => ProjectEntry[] | undefined) | undefined;
  sanitizeSettingsUpdate(settings: unknown): PiariumSettingsDocument;
  settingsStore?: SettingsFileStore | undefined;
  syncManagedRemoteTunnelConfigWithPresets(presets: unknown): Promise<void>;
  upsertManagedRemoteTunnelToken(update: ManagedTunnelTokenUpdate): Promise<void>;
}

export const createSettingsRuntime = (deps: SettingsRuntimeDependencies) => {
  const {
    fsPromises,
    path,
    SETTINGS_FILE_PATH,
    sanitizeSettingsUpdate,
    mergePersistedSettings,
    normalizeSettingsPaths,
    formatSettingsResponse,
    syncManagedRemoteTunnelConfigWithPresets,
    upsertManagedRemoteTunnelToken,
  } = deps;

  const settingsStore = deps.settingsStore ?? createSettingsFileStore({
    filePath: SETTINGS_FILE_PATH,
    fsPromises,
    pathModule: path,
  });
  const readSettingsFromDisk = () => settingsStore.read();
  const updateSettingsOnDisk = (
    mutator: Parameters<SettingsFileStore['update']>[0],
  ): Promise<PiariumSettingsDocument> => settingsStore.update(mutator);

  const validateProjectEntries = async (projects: unknown): Promise<ProjectEntry[]> => {
    if (!Array.isArray(projects)) {
      return [];
    }

    const validations = projects.map(async (project): Promise<ProjectEntry | null> => {
      if (!project || typeof project.path !== 'string' || project.path.length === 0) {
        console.warn('[validateProjectEntries] Dropping project entry with missing or empty path');
        return null;
      }
      try {
        const stats = await fsPromises.stat(project.path);
        if (!stats.isDirectory()) {
          console.warn(`[validateProjectEntries] Dropping project — path is not a directory: ${project.path}`);
          return null;
        }
        return project;
      } catch (error) {
        if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') {
          console.warn(`[validateProjectEntries] Dropping project — directory no longer exists: ${project.path}`);
          return null;
        }
        // Permission or transient fs error — keep the project rather than
        // silently losing it from the user's list.
        return project;
      }
    });

    return (await Promise.all(validations)).filter((p) => p !== null);
  };

  const persistSettings = async (
    changes: PiariumSettingsDocument,
  ): Promise<PiariumSettingsDocument> => {
    const next = await updateSettingsOnDisk(async (current) => {
      // Log field names only — changes can carry credentials (UI password,
      // client tokens, tunnel tokens) that must never reach the log file.
      console.log('[persistSettings] Updating fields:', Object.keys(changes || {}).join(', ') || '(none)');
      const sanitized = sanitizeSettingsUpdate(changes);
      let next = mergePersistedSettings(current, sanitized);

      const normalizedState = normalizeSettingsPaths(next);
      if (normalizedState.changed) {
        next = normalizedState.settings;
      }

      // Validating project paths hits the filesystem for every entry, so only
      // do it when the incoming update actually touches the projects list —
      // not on every theme/window-state/etc. save.
      if (Object.prototype.hasOwnProperty.call(sanitized, 'projects') && Array.isArray(next.projects)) {
        const validated = await validateProjectEntries(next.projects);
        next = { ...next, projects: validated };
      }

      const nextProjects = Array.isArray(next.projects)
        ? next.projects.filter((project): project is ProjectEntry => (
            Boolean(project) && typeof project === 'object'
            && typeof (project as { id?: unknown }).id === 'string'
            && typeof (project as { path?: unknown }).path === 'string'
          ))
        : [];
      if (nextProjects.length > 0) {
        const activeId = typeof next.activeProjectId === 'string' ? next.activeProjectId : null;
        const active = activeId
          ? nextProjects.find((project) => project.id === activeId) || null
          : null;
        if (activeId && !active) {
          console.log(`[persistSettings] Active project ID ${activeId} not found, clearing the workspace selection`);
          next = { ...next, activeProjectId: null };
        }
      } else if (typeof next.activeProjectId === 'string') {
        console.log(`[persistSettings] No projects found, clearing activeProjectId ${next.activeProjectId}`);
        next = { ...next, activeProjectId: null };
      }

      if (Object.prototype.hasOwnProperty.call(sanitized, 'managedRemoteTunnelPresets')) {
        await syncManagedRemoteTunnelConfigWithPresets(next.managedRemoteTunnelPresets);
      }

      if (Object.prototype.hasOwnProperty.call(sanitized, 'managedRemoteTunnelPresetTokens') && sanitized.managedRemoteTunnelPresetTokens) {
        const presets = Array.isArray(next.managedRemoteTunnelPresets)
          ? next.managedRemoteTunnelPresets.filter((entry): entry is ManagedTunnelPreset => (
              Boolean(entry) && typeof entry === 'object'
              && typeof (entry as { id?: unknown }).id === 'string'
              && typeof (entry as { name?: unknown }).name === 'string'
              && typeof (entry as { hostname?: unknown }).hostname === 'string'
            ))
          : [];
        const presetsById = new Map(presets.map((entry) => [entry.id, entry]));
        const updates = Object.entries(sanitized.managedRemoteTunnelPresetTokens)
          .map(([presetId, token]) => {
            const preset = presetsById.get(presetId);
            if (!preset || typeof token !== 'string' || token.trim().length === 0) {
              return null;
            }
            return {
              id: preset.id,
              name: preset.name,
              hostname: preset.hostname,
              token: token.trim(),
            };
          })
          .filter((entry): entry is ManagedTunnelTokenUpdate => Boolean(entry));

        for (const update of updates) {
          await upsertManagedRemoteTunnelToken(update);
        }
      }

      return next;
    });
    return formatSettingsResponse(next);
  };

  return {
    readSettingsFromDisk,
    updateSettingsOnDisk,
    persistSettings,
  };
};
