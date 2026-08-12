import type { I18nKey } from '@/lib/i18n';
import type { PiAgentCatalogSnapshot, PiAgentDescriptor } from '@piarium/protocol';
import type { AgentProviderFilter, AgentStatusFilter } from './agents-catalog-store';

export const AGENT_KIND_LABEL_KEYS: Partial<Record<string, I18nKey>> = {
  delegatable: 'settings.piarium.pluginSettings.subagents.kind.delegatable',
  internal: 'settings.piarium.agents.kind.internal',
  primary: 'settings.piarium.agents.kind.primary',
  profile: 'settings.piarium.agents.kind.profile',
  service: 'settings.piarium.agents.kind.service',
  workflow: 'settings.piarium.pluginSettings.subagents.kind.workflow',
};

export function filterAgentsCatalog(
  catalog: PiAgentCatalogSnapshot,
  query: string,
  providerFilter: AgentProviderFilter,
  statusFilter: AgentStatusFilter,
): PiAgentDescriptor[] {
  const providerById = new Map(catalog.providers.map((provider) => [provider.id, provider]));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return catalog.agents.filter((agent) => {
    if (providerFilter !== 'all' && agent.providerId !== providerFilter) return false;
    if (statusFilter !== 'all' && agent.status !== statusFilter) return false;
    if (!normalizedQuery) return true;
    const provider = providerById.get(agent.providerId);
    const haystack = [
      agent.name,
      agent.id,
      agent.description,
      agent.kind,
      agent.status,
      agent.model,
      agent.thinking,
      agent.source.scope,
      agent.source.path,
      agent.source.packageName,
      provider?.label,
      provider?.id,
      provider?.source,
      ...(agent.aliases ?? []),
      ...(agent.fallbackModels ?? []),
    ].filter(Boolean).join(' ').toLocaleLowerCase();
    return haystack.includes(normalizedQuery);
  });
}

