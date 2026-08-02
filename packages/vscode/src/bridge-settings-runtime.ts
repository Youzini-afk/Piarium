import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BridgeContext } from './bridge';

const SETTINGS_KEY = 'piarium.settings';
const SETTINGS_PATH = path.join(
  process.env.PIARIUM_DATA_DIR?.trim() || path.join(os.homedir(), '.config', 'piarium'),
  'settings.json',
);
const DERIVED_FIELDS = new Set(['themeVariant', 'lastDirectory']);

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

const readSettingsFile = (): Record<string, unknown> => {
  try {
    return asRecord(JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')));
  } catch {
    return {};
  }
};

const writeSettingsFile = async (settings: Record<string, unknown>): Promise<void> => {
  await fs.promises.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  const temporaryPath = `${SETTINGS_PATH}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs.promises.writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    await fs.promises.rename(temporaryPath, SETTINGS_PATH);
  } finally {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

const readPersistedSettings = (ctx?: BridgeContext): Record<string, unknown> => ({
  ...stripDerived(ctx?.context?.globalState.get<Record<string, unknown>>(SETTINGS_KEY) || {}),
  ...stripDerived(readSettingsFile()),
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
  const next = {
    ...readPersistedSettings(ctx),
    ...stripDerived(asRecord(changes)),
  };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) delete next[key];
  }
  await writeSettingsFile(next);
  await ctx?.context?.globalState.update(SETTINGS_KEY, next);
  return readSettings(ctx);
};
