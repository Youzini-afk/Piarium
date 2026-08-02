import type { ToolsAPI } from '@piarium/ui/lib/api/types';

export const createVSCodeToolsAPI = (): ToolsAPI => ({
  async getAvailableTools(): Promise<string[]> {
    return [];
  },
});
