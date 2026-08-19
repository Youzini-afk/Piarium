import type { PiAgentProviderDescriptor, RecoveryProviderDescriptor } from '@piarium/protocol';
import type { PluginSettingsIntegrationId } from '@/lib/settings/plugin-settings-navigation';

export type PluginRuntimeStatus = 'available' | 'checking' | 'error' | 'no-session' | 'not-observed' | 'unavailable';

export interface PluginRuntimeSignals {
  agentProviders: readonly PiAgentProviderDescriptor[];
  agentProvidersChecked: boolean;
  agentProvidersFailed: boolean;
  commandNames: ReadonlySet<string>;
  commandsChecked: boolean;
  commandsFailed: boolean;
  hasActiveSession: boolean;
  mcpStatusReported: boolean;
  recoveryChecked: boolean;
  recoveryFailed: boolean;
  recoveryProviders: readonly RecoveryProviderDescriptor[];
}

function providerStatus(providers: readonly PiAgentProviderDescriptor[], checked: boolean, failed: boolean, providerId: string): PluginRuntimeStatus {
  if (failed) return 'error';
  if (!checked) return 'checking';
  const provider = providers.find((candidate) => candidate.id === providerId);
  if (!provider) return 'not-observed';
  return provider.available ? 'available' : 'unavailable';
}

function recoveryProviderStatus(providers: readonly RecoveryProviderDescriptor[], checked: boolean, failed: boolean, providerId: string): PluginRuntimeStatus {
  if (failed) return 'error';
  if (!checked) return 'checking';
  const provider = providers.find((candidate) => candidate.id === providerId);
  if (!provider) return 'not-observed';
  return provider.active ? 'available' : 'unavailable';
}

export function pluginRuntimeStatus(integrationId: PluginSettingsIntegrationId, signals: PluginRuntimeSignals): PluginRuntimeStatus {
  if (!signals.hasActiveSession) return 'no-session';

  switch (integrationId) {
    case 'subagents':
      return providerStatus(signals.agentProviders, signals.agentProvidersChecked, signals.agentProvidersFailed, 'pi-subagents');
    case 'magic-context':
      return providerStatus(signals.agentProviders, signals.agentProvidersChecked, signals.agentProvidersFailed, 'magic-context');
    case 'web-access':
      if (signals.commandsFailed) return 'error';
      if (!signals.commandsChecked) return 'checking';
      return signals.commandNames.has('websearch') ? 'available' : 'not-observed';
    case 'openai-codex-compat':
      if (signals.commandsFailed) return 'error';
      if (!signals.commandsChecked) return 'checking';
      return signals.commandNames.has('codex-settings') ? 'available' : 'not-observed';
    case 'observational-memory':
      if (signals.commandsFailed) return 'error';
      if (!signals.commandsChecked) return 'checking';
      return signals.commandNames.has('om:status') ? 'available' : 'not-observed';
    case 'context-mode':
      if (signals.commandsFailed) return 'error';
      if (!signals.commandsChecked) return 'checking';
      return signals.commandNames.has('ctx-stats') ? 'available' : 'not-observed';
    case 'aft':
      if (signals.commandsFailed) return 'error';
      if (!signals.commandsChecked) return 'checking';
      return signals.commandNames.has('aft-status') ? 'available' : 'not-observed';
    case 'pi-lens':
      if (signals.commandsFailed) return 'error';
      if (!signals.commandsChecked) return 'checking';
      return signals.commandNames.has('lens-toggle') ? 'available' : 'not-observed';
    case 'permission-system':
      if (signals.commandsFailed) return 'error';
      if (!signals.commandsChecked) return 'checking';
      return signals.commandNames.has('permission-system') ? 'available' : 'not-observed';
    case 'workspace-history':
      return recoveryProviderStatus(signals.recoveryProviders, signals.recoveryChecked, signals.recoveryFailed, 'pi-workspace-history');
    case 'wtf':
      return recoveryProviderStatus(signals.recoveryProviders, signals.recoveryChecked, signals.recoveryFailed, 'pi-wtf');
    case 'mcp':
      return signals.mcpStatusReported ? 'available' : 'not-observed';
  }
}
