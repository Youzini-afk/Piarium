import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { createSettingsFileStore } from '@piarium/settings-store';
import type { BridgeContext } from './bridge';

const SETTINGS_KEY = 'piarium.settings';
const SETTINGS_PATH = path.join(
  process.env.PIARIUM_DATA_DIR?.trim() || path.join(os.homedir(), '.config', 'piarium'),
  'settings.json',
);
const DERIVED_FIELDS = new Set(['themeVariant', 'lastDirectory']);
const settingsStore = createSettingsFileStore({ filePath: SETTINGS_PATH });

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const stripDerived = (source: Record<string, unknown>): Record<string, unknown> => {
  const next = { ...source };
  for (const field of DERIVED_FIELDS) delete next[field];
  return next;
};

const readPersistedSettings = (ctx?: BridgeContext): Record<string, unknown> => ({
  ...stripDerived(ctx?.context?.globalState.get<Record<string, unknown>>(SETTINGS_KEY) || {}),
  ...stripDerived(settingsStore.readSync()),
});

export const readSettings = (ctx?: BridgeContext): Record<string, unknown> => {
  const light = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light
    || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight;
  return {
    ...readPersistedSettings(ctx),
    themeVariant: light ? 'light' : 'dark',
    lastDirectory: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
  };
};

export const persistSettings = async (
  changes: Record<string, unknown>,
  ctx?: BridgeContext,
): Promise<Record<string, unknown>> => {
  const persistedChanges = stripDerived(asRecord(changes));
  const next = await settingsStore.update((current) => {
    const updated = { ...stripDerived(current), ...persistedChanges };
    for (const [key, value] of Object.entries(updated)) {
      if (value === undefined) delete updated[key];
    }
    return updated;
  });
  await ctx?.context?.globalState.update(SETTINGS_KEY, next);
  return readSettings(ctx);
};
