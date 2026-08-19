export type PluginSettingsIntegrationId =
  | 'subagents'
  | 'magic-context'
  | 'web-access'
  | 'workspace-history'
  | 'wtf'
  | 'openai-codex-compat'
  | 'observational-memory'
  | 'context-mode'
  | 'mcp'
  | 'pi-lens';

export interface PluginSettingsNavigationTarget {
  integrationId: PluginSettingsIntegrationId | null;
  packageIdentity?: string;
  pluginId: string;
  section?: string;
}

const INTEGRATION_BY_PLUGIN_ID: Readonly<Record<string, PluginSettingsIntegrationId>> = {
  '@cortexkit/pi-magic-context': 'magic-context',
  'pi-magic-context': 'magic-context',
  'magic-context': 'magic-context',
  'pi-mcp-adapter': 'mcp',
  'pi-observational-memory': 'observational-memory',
  'pi-openai-codex-compat': 'openai-codex-compat',
  'context-mode': 'context-mode',
  'pi-subagents': 'subagents',
  'pi-web-access': 'web-access',
  'pi-workspace-history': 'workspace-history',
  'pi-wtf': 'wtf',
  'pi-lens': 'pi-lens',
};

export const pluginSettingsIntegrationForPluginId = (
  pluginId: string,
): PluginSettingsIntegrationId | null => {
  const normalized = pluginId.trim().replace(/^npm:/, '').replace(/@[^/@]+$/, '').toLowerCase();
  return INTEGRATION_BY_PLUGIN_ID[normalized] ?? null;
};

const PLUGIN_ID_BY_INTEGRATION: Readonly<Record<PluginSettingsIntegrationId, string>> = {
  'magic-context': '@cortexkit/pi-magic-context',
  'mcp': 'pi-mcp-adapter',
  'observational-memory': 'pi-observational-memory',
  'openai-codex-compat': 'pi-openai-codex-compat',
  'context-mode': 'context-mode',
  'subagents': 'pi-subagents',
  'web-access': 'pi-web-access',
  'workspace-history': 'pi-workspace-history',
  'wtf': 'pi-wtf',
  'pi-lens': 'pi-lens',
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

export const requestPluginSettingsTarget = (
  pluginId: string,
  section?: string,
  packageIdentity?: string,
): void => {
  pendingTarget = {
    integrationId: pluginSettingsIntegrationForPluginId(pluginId),
    pluginId,
    ...(packageIdentity === undefined ? {} : { packageIdentity }),
    ...(section === undefined ? {} : { section }),
  };
};

export const consumePluginSettingsTarget = (): PluginSettingsNavigationTarget | null => {
  const target = pendingTarget;
  pendingTarget = null;
  return target;
};
