import type { ToolsAPI } from '@openchamber/ui/lib/api/types';

export const createVSCodeToolsAPI = (): ToolsAPI => ({
  async getAvailableTools(): Promise<string[]> {
    return [];
  },
});
