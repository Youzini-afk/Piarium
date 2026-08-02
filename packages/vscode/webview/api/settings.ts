import type { SettingsAPI, SettingsLoadResult, SettingsPayload } from '@piarium/ui/lib/api/types';
import { sendBridgeMessage } from './bridge';

const sanitizePayload = (data: unknown): SettingsPayload => {
  if (!data || typeof data !== 'object') {
    return {};
  }
  return data as SettingsPayload;
};

export const createVSCodeSettingsAPI = (): SettingsAPI => ({
  async load(): Promise<SettingsLoadResult> {
    try {
      const payload = sanitizePayload(await sendBridgeMessage('api:settings:get'));
      return {
        settings: {
          ...payload,
          // Override with VS Code settings
          lastDirectory: window.__VSCODE_CONFIG__?.workspaceFolder || payload.lastDirectory || '',
        },
        source: 'web',
      };
    } catch {
      // Fallback to VS Code config
      return {
        settings: {
          themeVariant: window.__VSCODE_CONFIG__?.theme === 'light' ? 'light' : 'dark',
          lastDirectory: window.__VSCODE_CONFIG__?.workspaceFolder || '',
        },
        source: 'web',
      };
    }
  },

  async save(changes: Partial<SettingsPayload>): Promise<SettingsPayload> {
    return sanitizePayload(await sendBridgeMessage('api:settings:save', changes));
  },
});
