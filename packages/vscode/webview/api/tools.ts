import type { ToolsAPI } from '@piarium/application-client';

export const createVSCodeToolsAPI = (): ToolsAPI => ({
  async getAvailableTools(): Promise<string[]> {
    return [];
  },
});
