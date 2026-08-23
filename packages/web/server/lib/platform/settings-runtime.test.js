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
  it.skipIf(process.platform === 'win32')('writes settings with restrictive directory and file permissions', async () => {
    const { runtime, settingsFilePath, tempRoot, cleanup } = await createRuntime();
    try {
      await runtime.writeSettingsToDisk({ desktopUiPassword: 'secret' });

      expect((await fsPromises.stat(tempRoot)).mode & 0o777).toBe(0o700);
      expect((await fsPromises.stat(settingsFilePath)).mode & 0o777).toBe(0o600);
    } finally {
      await cleanup();
    }
  });

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

  it.skipIf(process.platform !== 'win32')('falls back when Windows blocks atomic settings replacement', async () => {
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'piarium-settings-runtime-'));
    const settingsFilePath = path.join(tempRoot, 'settings.json');
    const wrappedFs = {
      ...fsPromises,
      rename: async () => {
        const error = new Error('operation not permitted');
        error.code = 'EPERM';
        throw error;
      },
    };
    const runtime = createSettingsRuntime({
      fsPromises: wrappedFs,
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

    try {
      await runtime.writeSettingsToDisk({ theme: 'dark' });

      await expect(fsPromises.readFile(settingsFilePath, 'utf8')).resolves.toBe(JSON.stringify({ theme: 'dark' }, null, 2));
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
