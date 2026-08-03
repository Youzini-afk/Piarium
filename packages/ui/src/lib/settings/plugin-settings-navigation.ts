export type PluginSettingsIntegrationId =
  | 'subagents'
  | 'magic-context'
  | 'web-access'
  | 'workspace-history'
  | 'wtf'
  | 'mcp';

export interface PluginSettingsNavigationTarget {
  integrationId: PluginSettingsIntegrationId | null;
  pluginId: string;
  section?: string;
}

const INTEGRATION_BY_PLUGIN_ID: Readonly<Record<string, PluginSettingsIntegrationId>> = {
  '@cortexkit/pi-magic-context': 'magic-context',
  'pi-magic-context': 'magic-context',
  'magic-context': 'magic-context',
  'pi-mcp-adapter': 'mcp',
  'pi-subagents': 'subagents',
  'pi-web-access': 'web-access',
  'pi-workspace-history': 'workspace-history',
  'pi-wtf': 'wtf',
};

const PLUGIN_ID_BY_INTEGRATION: Readonly<Record<PluginSettingsIntegrationId, string>> = {
  'magic-context': '@cortexkit/pi-magic-context',
  'mcp': 'pi-mcp-adapter',
  'subagents': 'pi-subagents',
  'web-access': 'pi-web-access',
  'workspace-history': 'pi-workspace-history',
  'wtf': 'pi-wtf',
};

let pendingTarget: PluginSettingsNavigationTarget | null = null;

export const requestPluginSettingsIntegration = (
  integrationId: PluginSettingsIntegrationId,
): void => {
  pendingTarget = {
    integrationId,
    pluginId: PLUGIN_ID_BY_INTEGRATION[integrationId],
  };
};

export const requestPluginSettingsTarget = (pluginId: string, section?: string): void => {
  const normalized = pluginId.trim().replace(/^npm:/, '').toLowerCase();
  pendingTarget = {
    integrationId: INTEGRATION_BY_PLUGIN_ID[normalized] ?? null,
    pluginId,
    ...(section === undefined ? {} : { section }),
  };
};

export const consumePluginSettingsTarget = (): PluginSettingsNavigationTarget | null => {
  const target = pendingTarget;
  pendingTarget = null;
  return target;
};
