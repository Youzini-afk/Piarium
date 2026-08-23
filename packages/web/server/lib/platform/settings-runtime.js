export const createSettingsRuntime = (deps) => {
  const {
    fsPromises,
    path,
    SETTINGS_FILE_PATH,
    sanitizeProjects,
    sanitizeSettingsUpdate,
    mergePersistedSettings,
    normalizeSettingsPaths,
    formatSettingsResponse,
    syncManagedRemoteTunnelConfigWithPresets,
    upsertManagedRemoteTunnelToken,
  } = deps;

  let persistSettingsLock = Promise.resolve();

  const readSettingsFromDisk = async () => {
    let raw;
    try {
      raw = await fsPromises.readFile(SETTINGS_FILE_PATH, 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return {};
      }
      throw error;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Settings file is malformed (non-object payload)');
    }
    return parsed;
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const isTransientWindowsReplaceError = (error) => {
    if (process.platform !== 'win32' || !error || typeof error !== 'object') {
      return false;
    }
    return error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY';
  };

  const replaceFile = async (tmp, target) => {
    const maxAttempts = process.platform === 'win32' ? 6 : 1;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await fsPromises.rename(tmp, target);
        return;
      } catch (error) {
        lastError = error;
        if (!isTransientWindowsReplaceError(error) || attempt === maxAttempts) {
          break;
        }
        await sleep(25 * attempt);
      }
    }

    if (!isTransientWindowsReplaceError(lastError)) {
      throw lastError;
    }

    // Windows can transiently reject atomic replacement when another process
    // briefly opens the target file. Preserve atomic rename everywhere it works,
    // but fall back to a direct replacement so settings persistence does not
    // get permanently wedged on Windows desktop installs.
    await fsPromises.copyFile(tmp, target);
    await fsPromises.rm(tmp, { force: true });
  };

  const writeSettingsToDisk = async (settings) => {
    try {
      const settingsDirectory = path.dirname(SETTINGS_FILE_PATH);
      await fsPromises.mkdir(settingsDirectory, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') await fsPromises.chmod(settingsDirectory, 0o700);
      // Atomic write: Electron main and ssh-manager read this file via plain
      // readFile + JSON.parse and silently coerce parse errors to {}. A
      // partial read during a non-atomic writeFile would make their next
      // read-modify-write wipe the settings file.
      const tmp = `${SETTINGS_FILE_PATH}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await fsPromises.writeFile(tmp, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
      if (process.platform !== 'win32') await fsPromises.chmod(tmp, 0o600);
      await replaceFile(tmp, SETTINGS_FILE_PATH);
      if (process.platform !== 'win32') await fsPromises.chmod(SETTINGS_FILE_PATH, 0o600);
    } catch (error) {
      console.warn('Failed to write settings file:', error);
      throw error;
    }
  };

  const validateProjectEntries = async (projects) => {
    if (!Array.isArray(projects)) {
      return [];
    }

    const validations = projects.map(async (project) => {
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
        if (error && typeof error === 'object' && error.code === 'ENOENT') {
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

  const persistSettings = async (changes) => {
    persistSettingsLock = persistSettingsLock.then(async () => {
      // Log field names only — changes can carry credentials (UI password,
      // client tokens, tunnel tokens) that must never reach the log file.
      console.log('[persistSettings] Updating fields:', Object.keys(changes || {}).join(', ') || '(none)');
      const current = await readSettingsFromDisk();
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

      if (Array.isArray(next.projects) && next.projects.length > 0) {
        const activeId = typeof next.activeProjectId === 'string' ? next.activeProjectId : '';
        const active = next.projects.find((project) => project.id === activeId) || null;
        if (!active) {
          console.log(`[persistSettings] Active project ID ${activeId} not found, switching to ${next.projects[0].id}`);
          next = { ...next, activeProjectId: next.projects[0].id };
        }
      } else if (next.activeProjectId) {
        console.log(`[persistSettings] No projects found, clearing activeProjectId ${next.activeProjectId}`);
        next = { ...next, activeProjectId: undefined };
      }

      if (Object.prototype.hasOwnProperty.call(sanitized, 'managedRemoteTunnelPresets')) {
        await syncManagedRemoteTunnelConfigWithPresets(next.managedRemoteTunnelPresets);
      }

      if (Object.prototype.hasOwnProperty.call(sanitized, 'managedRemoteTunnelPresetTokens') && sanitized.managedRemoteTunnelPresetTokens) {
        const presetsById = new Map((next.managedRemoteTunnelPresets || []).map((entry) => [entry.id, entry]));
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
          .filter(Boolean);

        for (const update of updates) {
          await upsertManagedRemoteTunnelToken(update);
        }
      }

      await writeSettingsToDisk(next);
      return formatSettingsResponse(next);
    });

    return persistSettingsLock;
  };

  return {
    readSettingsFromDisk,
    writeSettingsToDisk,
    persistSettings,
  };
};
