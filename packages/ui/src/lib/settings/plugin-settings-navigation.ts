export type PluginSettingsIntegrationId =
  | 'subagents'
  | 'magic-context'
  | 'web-access'
  | 'workspace-history'
  | 'wtf'
  | 'mcp';

let pendingSelection: PluginSettingsIntegrationId | null = null;

export const requestPluginSettingsSelection = (selection: PluginSettingsIntegrationId): void => {
  pendingSelection = selection;
};

export const consumePluginSettingsSelection = (): PluginSettingsIntegrationId | null => {
  const selection = pendingSelection;
  pendingSelection = null;
  return selection;
};
