import { describe, expect, it } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { createSettingsRuntime } from './settings-runtime.js';

const createRuntime = async () => {
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'piarium-settings-runtime-'));
  const settingsFilePath = path.join(tempRoot, 'settings.json');
  const runtime = createSettingsRuntime({
    fsPromises,
    path,
    SETTINGS_FILE_PATH: settingsFilePath,
    sanitizeProjects: (projects) => Array.isArray(projects) ? projects : [],
    sanitizeSettingsUpdate: (settings) => settings,
    mergePersistedSettings: (_current, changes) => changes,
    normalizeSettingsPaths: (settings) => ({ settings, changed: false }),
    formatSettingsResponse: (settings) => settings,
    syncManagedRemoteTunnelConfigWithPresets: async () => {},
    upsertManagedRemoteTunnelToken: async () => {},
  });

  return {
    runtime,
    settingsFilePath,
    tempRoot,
    cleanup: async () => {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    },
  };
};

describe('settings runtime', () => {
  it('reads the current settings document without rewriting it', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime();
    try {
      const source = '{"themeId":"piarium-dark"}\n';
      await fsPromises.writeFile(settingsFilePath, source, 'utf8');

      await expect(runtime.readSettingsFromDisk()).resolves.toEqual({ themeId: 'piarium-dark' });
      await expect(fsPromises.readFile(settingsFilePath, 'utf8')).resolves.toBe(source);
    } finally {
      await cleanup();
    }
  });

  it('surfaces malformed settings instead of treating them as an empty first run', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRuntime();
    try {
      const source = '{"themeId":';
      await fsPromises.writeFile(settingsFilePath, source, 'utf8');

      await expect(runtime.readSettingsFromDisk()).rejects.toBeInstanceOf(SyntaxError);
      await expect(fsPromises.readFile(settingsFilePath, 'utf8')).resolves.toBe(source);
    } finally {
      await cleanup();
    }
  });

});
