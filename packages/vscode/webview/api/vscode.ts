import type { VSCodeAPI } from '@openchamber/ui/lib/api/types';
import { executeVSCodeCommand, openVSCodeExternalUrl, sendBridgeMessage } from './bridge';

export const createVSCodeActionsAPI = (): VSCodeAPI => ({
  async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    const result = await executeVSCodeCommand(command, args);
    return result.result;
  },

  async openAgentManager(): Promise<void> {
    await executeVSCodeCommand('openchamber.openAgentManager');
  },

  async openSettings(settingsPage?: string): Promise<void> {
    if (settingsPage && settingsPage.trim().length > 0) {
      await executeVSCodeCommand('openchamber.showSettings', [settingsPage.trim()]);
      return;
    }
    await executeVSCodeCommand('openchamber.showSettings');
  },

  async openExternalUrl(url: string): Promise<void> {
    await openVSCodeExternalUrl(url);
  },

  async pickFiles(options): Promise<unknown> {
    return sendBridgeMessage('api:files/pick', options);
  },

  async saveImage(payload: unknown): Promise<unknown> {
    return sendBridgeMessage('api:files/save-image', payload);
  },

  async saveMarkdown(payload: unknown): Promise<unknown> {
    return sendBridgeMessage('api:files/save-markdown', payload);
  },
});
