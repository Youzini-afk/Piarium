import React from 'react';
import type { PiAgentCatalogSnapshot, PiAgentDescriptor } from '@piarium/protocol';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { listPiAgentProviders } from '@/lib/pi-runtime/agent-providers';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@piarium/application-client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import type { MultiRunAgentSelection } from '@/types/multirun';

const DIRECT_PI_VALUE = '__piarium_direct__';

const EMPTY_CATALOG: PiAgentCatalogSnapshot = {
  agents: [],
  diagnostics: [],
  projectTrusted: false,
  providers: [],
};

const canInvoke = (agent: PiAgentDescriptor): boolean => (
  agent.status === 'available' && agent.invocation !== undefined
);

const toSelection = (agent: PiAgentDescriptor): MultiRunAgentSelection | null => {
  if (!agent.invocation) return null;
  return {
    id: agent.id,
    invocation: agent.invocation,
    name: agent.name,
    providerId: agent.providerId,
  };
};

export interface PiAgentSelectorProps {
  className?: string;
  cwd?: string | null;
  disabled?: boolean;
  id?: string;
  onChange(value: MultiRunAgentSelection | null): void;
  portalToBody?: boolean;
  value: MultiRunAgentSelection | null;
}

export const PiAgentSelector: React.FC<PiAgentSelectorProps> = ({
  className,
  cwd,
  disabled,
  id,
  onChange,
  portalToBody,
  value,
}) => {
  const { t } = useI18n();
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const targetCwd = cwd?.trim() || currentDirectory?.trim() || '';
  const [catalog, setCatalog] = React.useState<PiAgentCatalogSnapshot>(EMPTY_CATALOG);
  const [catalogLoaded, setCatalogLoaded] = React.useState(false);
  const [runtimeEpoch, setRuntimeEpoch] = React.useState(0);
  const generationRef = React.useRef(0);

  React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
    setRuntimeEpoch((epoch) => epoch + 1);
  }), []);

  React.useEffect(() => {
    const generation = ++generationRef.current;
    const runtimeKey = getRuntimeKey();
    setCatalogLoaded(false);
    if (!targetCwd) {
      setCatalog(EMPTY_CATALOG);
      setCatalogLoaded(true);
      return;
    }
    void listPiAgentProviders({ cwd: targetCwd })
      .then((next) => {
        if (generation !== generationRef.current || runtimeKey !== getRuntimeKey()) return;
        setCatalog(next);
        setCatalogLoaded(true);
      })
      .catch((error) => {
        if (generation !== generationRef.current || runtimeKey !== getRuntimeKey()) return;
        console.warn('[pi-agent-selector] failed to load agents', error);
        setCatalog(EMPTY_CATALOG);
        setCatalogLoaded(true);
      });
  }, [runtimeEpoch, targetCwd]);

  const agents = React.useMemo(() => catalog.agents
    .filter(canInvoke)
    .sort((left, right) => {
      const providerOrder = left.providerId.localeCompare(right.providerId);
      return providerOrder !== 0 ? providerOrder : left.name.localeCompare(right.name);
    }), [catalog.agents]);
  const providerNames = React.useMemo(() => new Map(
    catalog.providers.map((provider) => [provider.id, provider.label]),
  ), [catalog.providers]);

  React.useEffect(() => {
    if (!catalogLoaded || !value) return;
    if (!agents.some((agent) => agent.id === value.id)) onChange(null);
  }, [agents, catalogLoaded, onChange, value]);

  return (
    <Select
      value={value?.id ?? DIRECT_PI_VALUE}
      onValueChange={(nextId) => {
        if (nextId === DIRECT_PI_VALUE) {
          onChange(null);
          return;
        }
        const next = agents.find((agent) => agent.id === nextId);
        if (next) onChange(toSelection(next));
      }}
      disabled={disabled}
    >
      <SelectTrigger id={id} size="lg" className={cn('max-w-full', className)}>
        <SelectValue placeholder={t('multirun.agentSelector.placeholder')} />
      </SelectTrigger>
      <SelectContent fitContent portalToBody={portalToBody}>
        <SelectGroup>
          <SelectItem value={DIRECT_PI_VALUE} className="w-auto whitespace-nowrap">
            Pi
          </SelectItem>
          {agents.map((agent) => (
            <SelectItem key={agent.id} value={agent.id} className="w-auto whitespace-nowrap">
              {providerNames.get(agent.providerId) ?? agent.providerId} / {agent.name}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
};
