import React from 'react';
import type {
  JsonValue,
  PiAgentActionDescriptor,
  PiAgentCatalogSnapshot,
  RuntimeContextTarget,
} from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { PiSubagentsDefinitionDialog } from '@/components/sections/agents/PiSubagentsDefinitionDialog';
import {
  isSupportedPiSubagentsThinking,
  PI_SUBAGENTS_THINKING_LEVELS,
  runPiSubagentsDefinitionAction,
  type PiSubagentsDefinitionMode,
} from '@/components/sections/agents/pi-subagents-action-model';
import {
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SettingsControlGroup,
  SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import {
  listPiAgentProviders,
  runPiAgentProviderAction,
} from '@/lib/pi-runtime/agent-providers';
import { getRuntimeKey } from '@/lib/runtime-switch';
import {
  PluginOptionalBooleanField,
  PluginOptionalSelectField,
} from './PluginConfigFields';
import { PluginRuntimeNote } from './PluginSettingsPanelShared';
import {
  asJsonObject,
  hasJsonPath,
  readJsonPath,
  validStringArray,
  type JsonObject,
} from './plugin-config-model';

type ActionScope = 'user' | 'project';

interface SubagentsAgentOverridesProps {
  disabled: boolean;
  draft: JsonObject;
  onRemove: (path: readonly string[]) => void;
  onSet: (path: readonly string[], value: JsonValue) => void;
  runtimeTarget: RuntimeContextTarget;
  scope: ActionScope;
  targetKey: string;
}

interface OverrideFieldProps {
  disabled: boolean;
  draft: JsonObject;
  label: string;
  onRemove: (path: readonly string[]) => void;
  onSet: (path: readonly string[], value: JsonValue) => void;
  path: readonly string[];
  placeholder?: string;
}

const splitModel = (value: string): { modelId: string; providerId: string } => {
  const separator = value.indexOf('/');
  return separator > 0
    ? { providerId: value.slice(0, separator), modelId: value.slice(separator + 1) }
    : { providerId: '', modelId: value };
};

const ModelPicker = ({
  disabled,
  onChange,
  placeholder,
  value,
}: {
  disabled: boolean;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) => {
  const parsed = splitModel(value);
  return (
    <div
      aria-disabled={disabled}
      className={disabled ? 'pointer-events-none opacity-60' : undefined}
      inert={disabled ? true : undefined}
    >
      <ModelSelector
        providerId={parsed.providerId}
        modelId={parsed.modelId}
        placeholder={placeholder}
        onChange={(providerId, modelId) => onChange(
          providerId && modelId ? `${providerId}/${modelId}` : '',
        )}
        className="w-full max-w-72 justify-between"
        dropdownPortalToBody
      />
    </div>
  );
};

const OverrideModelField: React.FC<OverrideFieldProps> = ({
  disabled,
  draft,
  label,
  onRemove,
  onSet,
  path,
  placeholder = '',
}) => {
  const { t } = useI18n();
  const raw = readJsonPath(draft, path);
  const mode = raw === false ? 'clear' : typeof raw === 'string' ? 'override' : 'inherit';
  return (
    <SettingsFieldRow label={label} alignEnd={false} controlClassName="w-full max-w-lg items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-2 @xl:flex-row">
        <Select
          value={mode}
          disabled={disabled}
          onValueChange={(next) => {
            if (next === 'inherit') onRemove(path);
            else if (next === 'clear') onSet(path, false);
            else onSet(path, typeof raw === 'string' ? raw : '');
          }}
        >
          <SelectTrigger size="settings" className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={label}>
            <SelectValue>
              {t(`settings.piarium.pluginSettings.subagents.overrides.mode.${mode}` as Parameters<typeof t>[0])}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">{t('settings.piarium.pluginSettings.subagents.overrides.mode.inherit')}</SelectItem>
            <SelectItem value="clear">{t('settings.piarium.pluginSettings.subagents.overrides.mode.clear')}</SelectItem>
            <SelectItem value="override">{t('settings.piarium.pluginSettings.subagents.overrides.mode.override')}</SelectItem>
          </SelectContent>
        </Select>
        {mode === 'override' ? (
          <ModelPicker
            disabled={disabled}
            value={typeof raw === 'string' ? raw : ''}
            placeholder={placeholder}
            onChange={(next) => next ? onSet(path, next) : onSet(path, '')}
          />
        ) : null}
      </div>
    </SettingsFieldRow>
  );
};

const OverrideThinkingField: React.FC<OverrideFieldProps> = ({
  disabled,
  draft,
  label,
  onRemove,
  onSet,
  path,
}) => {
  const { t } = useI18n();
  const tx = React.useCallback((key: string) => t(key as Parameters<typeof t>[0]), [t]);
  const raw = readJsonPath(draft, path);
  const mode = raw === false ? 'clear' : typeof raw === 'string' ? 'override' : 'inherit';
  const rawThinking = typeof raw === 'string' ? raw : '';
  const value = rawThinking && !isSupportedPiSubagentsThinking(rawThinking)
    ? 'unsupported'
    : rawThinking || 'medium';
  return (
    <SettingsFieldRow label={label} alignEnd={false} controlClassName="w-full max-w-lg items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-2 @xl:flex-row">
        <Select
          value={mode}
          disabled={disabled}
          onValueChange={(next) => {
            if (next === 'inherit') onRemove(path);
            else if (next === 'clear') onSet(path, false);
            else onSet(path, typeof raw === 'string' ? raw : 'medium');
          }}
        >
          <SelectTrigger size="settings" className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={label}>
            <SelectValue>
              {t(`settings.piarium.pluginSettings.subagents.overrides.mode.${mode}` as Parameters<typeof t>[0])}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">{t('settings.piarium.pluginSettings.subagents.overrides.mode.inherit')}</SelectItem>
            <SelectItem value="clear">{t('settings.piarium.pluginSettings.subagents.overrides.mode.clear')}</SelectItem>
            <SelectItem value="override">{t('settings.piarium.pluginSettings.subagents.overrides.mode.override')}</SelectItem>
          </SelectContent>
        </Select>
        {mode === 'override' ? (
          <Select
            value={value}
            disabled={disabled}
            onValueChange={(next) => { if (next !== 'unsupported') onSet(path, next); }}
          >
            <SelectTrigger size="settings" className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={label}>
              <SelectValue>
                {value === 'unsupported'
                  ? t('settings.piarium.pluginSettings.field.unsupportedValue')
                  : tx(`settings.piarium.pluginSettings.subagents.thinking.${value}`)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {value === 'unsupported' ? (
                <SelectItem value="unsupported" disabled>
                  {t('settings.piarium.pluginSettings.field.unsupportedValue')}
                </SelectItem>
              ) : null}
              {PI_SUBAGENTS_THINKING_LEVELS.map((level) => (
                <SelectItem key={level} value={level}>
                  {tx(`settings.piarium.pluginSettings.subagents.thinking.${level}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
    </SettingsFieldRow>
  );
};

const OverrideAvailabilityField: React.FC<OverrideFieldProps> = ({
  disabled,
  draft,
  label,
  onRemove,
  onSet,
  path,
}) => {
  const { t } = useI18n();
  const raw = readJsonPath(draft, path);
  const value = raw === true ? 'disabled' : raw === false ? 'available' : 'inherit';
  return (
    <SettingsFieldRow label={label} controlClassName="w-full max-w-lg">
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === 'inherit') onRemove(path);
          else onSet(path, next === 'disabled');
        }}
      >
        <SelectTrigger size="settings" className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={label}>
          <SelectValue>
            {value === 'inherit'
              ? t('settings.piarium.pluginSettings.subagents.overrides.mode.inherit')
              : t(`settings.piarium.pluginSettings.subagents.status.${value}` as Parameters<typeof t>[0])}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">{t('settings.piarium.pluginSettings.subagents.overrides.mode.inherit')}</SelectItem>
          <SelectItem value="available">{t('settings.piarium.pluginSettings.subagents.status.available')}</SelectItem>
          <SelectItem value="disabled">{t('settings.piarium.pluginSettings.subagents.status.disabled')}</SelectItem>
        </SelectContent>
      </Select>
    </SettingsFieldRow>
  );
};

const OverrideListOrClearField: React.FC<OverrideFieldProps> = ({
  disabled,
  draft,
  label,
  onRemove,
  onSet,
  path,
  placeholder,
}) => {
  const { t } = useI18n();
  const raw = readJsonPath(draft, path);
  const values = validStringArray(raw);
  const mode = raw === false ? 'clear' : values ? 'override' : 'inherit';
  return (
    <SettingsFieldRow label={label} alignEnd={false} controlClassName="w-full max-w-lg items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-2 @xl:flex-row">
        <Select
          value={mode}
          disabled={disabled}
          onValueChange={(next) => {
            if (next === 'inherit') onRemove(path);
            else if (next === 'clear') onSet(path, false);
            else onSet(path, values ?? []);
          }}
        >
          <SelectTrigger size="settings" className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={label}>
            <SelectValue>
              {t(`settings.piarium.pluginSettings.subagents.overrides.mode.${mode}` as Parameters<typeof t>[0])}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">{t('settings.piarium.pluginSettings.subagents.overrides.mode.inherit')}</SelectItem>
            <SelectItem value="clear">{t('settings.piarium.pluginSettings.subagents.overrides.mode.clear')}</SelectItem>
            <SelectItem value="override">{t('settings.piarium.pluginSettings.subagents.overrides.mode.override')}</SelectItem>
          </SelectContent>
        </Select>
        {mode === 'override' ? (
          <Textarea
            value={(values ?? []).join('\n')}
            disabled={disabled}
            placeholder={placeholder}
            aria-label={label}
            onChange={(event) => onSet(path, event.target.value
              .split(/\r?\n/)
              .map((entry) => entry.trim())
              .filter(Boolean))}
            className="min-h-20 min-w-0 flex-1 font-mono"
          />
        ) : null}
      </div>
    </SettingsFieldRow>
  );
};

const OverrideToolBudgetField: React.FC<OverrideFieldProps> = ({
  disabled,
  draft,
  label,
  onRemove,
  onSet,
  path,
}) => {
  const { t } = useI18n();
  const tx = React.useCallback((key: string) => t(key as Parameters<typeof t>[0]), [t]);
  const raw = readJsonPath(draft, path);
  const hasBudget = typeof raw === 'object' && raw !== null && !Array.isArray(raw);
  const budget = hasBudget ? asJsonObject(raw) : undefined;
  const mode = raw === false ? 'clear' : hasBudget ? 'override' : 'inherit';
  const block = budget?.block;
  const blockList = validStringArray(block);
  const blockMode = block === '*' ? 'all' : blockList ? 'list' : 'default';
  return (
    <div className="space-y-3">
      <SettingsFieldRow label={label} controlClassName="w-full max-w-lg">
        <Select
          value={mode}
          disabled={disabled}
          onValueChange={(next) => {
            if (next === 'inherit') onRemove(path);
            else if (next === 'clear') onSet(path, false);
            else onSet(path, budget ?? { hard: 16 });
          }}
        >
          <SelectTrigger size="settings" className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={label}>
            <SelectValue>
              {t(`settings.piarium.pluginSettings.subagents.overrides.mode.${mode}` as Parameters<typeof t>[0])}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">{t('settings.piarium.pluginSettings.subagents.overrides.mode.inherit')}</SelectItem>
            <SelectItem value="clear">{t('settings.piarium.pluginSettings.subagents.overrides.mode.clear')}</SelectItem>
            <SelectItem value="override">{t('settings.piarium.pluginSettings.subagents.overrides.mode.override')}</SelectItem>
          </SelectContent>
        </Select>
      </SettingsFieldRow>
      {mode === 'override' ? (
        <div className="space-y-3 border-t border-border/60 pt-3">
          <SettingsFieldRow label={tx('settings.piarium.pluginSettings.subagents.field.toolBudgetHard')} controlClassName="w-full max-w-lg">
            <NumberInput value={typeof budget?.hard === 'number' ? budget.hard : undefined} fallbackValue={16} disabled={disabled} min={1} step={1} onValueChange={(value) => onSet([...path, 'hard'], value)} containerClassName="w-36" />
          </SettingsFieldRow>
          <SettingsFieldRow label={tx('settings.piarium.pluginSettings.subagents.field.toolBudgetSoft')} controlClassName="w-full max-w-lg">
            <NumberInput value={typeof budget?.soft === 'number' ? budget.soft : undefined} fallbackValue={10} disabled={disabled} min={1} step={1} onClear={() => onRemove([...path, 'soft'])} onValueChange={(value) => onSet([...path, 'soft'], value)} containerClassName="w-36" emptyLabel={t('settings.piarium.pluginSettings.field.pluginDefault')} />
          </SettingsFieldRow>
          <SettingsFieldRow label={tx('settings.piarium.pluginSettings.subagents.field.toolsAfterBudget')} alignEnd={false} controlClassName="w-full max-w-lg items-start">
            <div className="flex min-w-0 flex-1 flex-col gap-2 @xl:flex-row">
              <Select
                value={blockMode}
                disabled={disabled}
                onValueChange={(next) => {
                  if (next === 'default') onRemove([...path, 'block']);
                  else if (next === 'all') onSet([...path, 'block'], '*');
                  else onSet([...path, 'block'], blockList ?? ['read', 'grep', 'find', 'ls']);
                }}
              >
                <SelectTrigger size="settings" className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                  <SelectValue>
                    {blockMode === 'default'
                      ? t('settings.piarium.pluginSettings.field.pluginDefault')
                      : tx(`settings.piarium.pluginSettings.subagents.value.${blockMode === 'all' ? 'allTools' : 'selectedTools'}`)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">{t('settings.piarium.pluginSettings.field.pluginDefault')}</SelectItem>
                  <SelectItem value="all">{tx('settings.piarium.pluginSettings.subagents.value.allTools')}</SelectItem>
                  <SelectItem value="list">{tx('settings.piarium.pluginSettings.subagents.value.selectedTools')}</SelectItem>
                </SelectContent>
              </Select>
              {blockMode === 'list' ? (
                <Textarea value={(blockList ?? []).join('\n')} disabled={disabled} placeholder={'read\ngrep\nfind\nls'} onChange={(event) => onSet([...path, 'block'], event.target.value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean))} className="min-h-20 min-w-0 flex-1 font-mono" />
              ) : null}
            </div>
          </SettingsFieldRow>
        </div>
      ) : null}
    </div>
  );
};

export const SubagentsAgentOverrides: React.FC<SubagentsAgentOverridesProps> = ({
  disabled,
  draft,
  onRemove,
  onSet,
  runtimeTarget,
  scope,
  targetKey,
}) => {
  const { t } = useI18n();
  const tx = React.useCallback((key: string) => t(key as Parameters<typeof t>[0]), [t]);
  const [catalog, setCatalog] = React.useState<PiAgentCatalogSnapshot | null>(null);
  const [catalogError, setCatalogError] = React.useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [nameInput, setNameInput] = React.useState('');
  const [selectedOverrideName, setSelectedOverrideName] = React.useState('');
  const [definitionMode, setDefinitionMode] = React.useState<PiSubagentsDefinitionMode | null>(null);
  const [actionMessage, setActionMessage] = React.useState<{ message?: string; success: boolean } | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const generationRef = React.useRef(0);
  const targetKeyRef = React.useRef(targetKey);
  targetKeyRef.current = targetKey;
  const listId = React.useId();
  const actionLabel = React.useCallback((
    action: PiAgentActionDescriptor,
    kind: PiAgentCatalogSnapshot['agents'][number]['kind'],
  ): string => {
    switch (action.id) {
      case 'create-agent': return t('settings.piarium.agents.definition.createAgent');
      case 'create-workflow': return t('settings.piarium.agents.definition.createWorkflow');
      case 'models': return t('settings.piarium.agents.actions.models');
      case 'inspect': return t('settings.piarium.agents.actions.inspect');
      case 'update': return t(kind === 'workflow'
        ? 'settings.piarium.agents.definition.editWorkflow'
        : 'settings.piarium.agents.definition.editAgent');
      case 'delete': return t('settings.common.actions.delete');
      case 'eject': return t('settings.piarium.agents.actions.copyToScope');
      case 'disable': return t('settings.piarium.agents.actions.disable');
      case 'enable': return t('settings.piarium.agents.actions.enable');
      case 'reset': return t('settings.common.actions.reset');
      default: return action.label;
    }
  }, [t]);

  const refreshCatalog = React.useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    const actionTargetKey = targetKey;
    const runtimeKey = getRuntimeKey();
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const next = await listPiAgentProviders(runtimeTarget);
      if (generation !== generationRef.current || actionTargetKey !== targetKeyRef.current || runtimeKey !== getRuntimeKey()) return;
      setCatalog(next);
      setSelectedId((current) => current && next.agents.some((agent) => agent.id === current)
        ? current
        : (next.agents.find((agent) => agent.providerId === 'pi-subagents')?.id ?? null));
    } catch (error) {
      if (generation !== generationRef.current || actionTargetKey !== targetKeyRef.current || runtimeKey !== getRuntimeKey()) return;
      setCatalogError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === generationRef.current && actionTargetKey === targetKeyRef.current && runtimeKey === getRuntimeKey()) setCatalogLoading(false);
    }
  }, [runtimeTarget, targetKey]);

  React.useEffect(() => {
    setCatalog(null);
    setSelectedId(null);
    setDefinitionMode(null);
    void refreshCatalog();
  }, [refreshCatalog]);

  const agents = React.useMemo(() => catalog?.agents.filter((agent) => agent.providerId === 'pi-subagents') ?? [], [catalog?.agents]);
  const selectedAgent = agents.find((agent) => agent.id === selectedId);
  const provider = catalog?.providers.find((entry) => entry.id === 'pi-subagents');
  const overrides = asJsonObject(readJsonPath(draft, ['agentOverrides']));
  const overridableAgents = agents.filter((agent) => agent.kind === 'delegatable');
  const overrideNames = [...new Set([...Object.keys(overrides), ...overridableAgents.map((agent) => agent.name)])]
    .sort((left, right) => left.localeCompare(right));

  React.useEffect(() => {
    if (selectedAgent?.kind === 'delegatable') {
      setSelectedOverrideName(selectedAgent.name);
      setNameInput(selectedAgent.name);
    }
  }, [selectedAgent]);

  React.useEffect(() => {
    if (selectedOverrideName || overrideNames.length === 0) return;
    setSelectedOverrideName(overrideNames[0] ?? '');
    setNameInput(overrideNames[0] ?? '');
  }, [overrideNames, selectedOverrideName]);

  const selectedPath = ['agentOverrides', selectedOverrideName] as const;
  const hasOverride = Boolean(selectedOverrideName) && hasJsonPath(draft, selectedPath);
  const selectedOverrideAgent = overridableAgents.find((agent) => agent.name === selectedOverrideName);
  const fieldProps = { disabled: disabled || !selectedOverrideName, draft, onRemove, onSet };
  const createAgentAvailable = provider?.actions.some((action) => action.id === 'create-agent') === true;
  const createWorkflowAvailable = provider?.actions.some((action) => action.id === 'create-workflow') === true;
  const definitionAgent = definitionMode === 'update-agent' || definitionMode === 'update-workflow'
    ? selectedAgent
    : undefined;

  const submitDefinition = React.useCallback(async (
    actionScope: ActionScope,
    config: Record<string, JsonValue>,
  ): Promise<boolean> => {
    if (!definitionMode) return false;
    setSubmitting(true);
    setActionMessage(null);
    try {
      const result = await runPiSubagentsDefinitionAction({
        agent: definitionAgent,
        config,
        mode: definitionMode,
        runtimeTarget,
        scope: actionScope,
      }, {
        refreshCatalog,
        runAction: runPiAgentProviderAction,
      });
      setActionMessage(result);
      return result.success;
    } catch (error) {
      setActionMessage({ message: error instanceof Error ? error.message : String(error), success: false });
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [definitionAgent, definitionMode, refreshCatalog, runtimeTarget]);

  const selectOverride = (): void => {
    const next = nameInput.trim();
    if (next) setSelectedOverrideName(next);
  };

  return (
    <div className="space-y-6">
      <SettingsControlGroup
        title={tx('settings.piarium.pluginSettings.subagents.catalog.title')}
        description={tx('settings.piarium.pluginSettings.subagents.catalog.description')}
        contentClassName="space-y-4"
      >
        <PluginRuntimeNote>
          {tx('settings.piarium.pluginSettings.subagents.authority.definitions')}
        </PluginRuntimeNote>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={!createAgentAvailable || submitting} onClick={() => setDefinitionMode('create-agent')}>
            <Icon name="add" className="size-4" />
            {t('settings.piarium.agents.definition.createAgent')}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={!createWorkflowAvailable || submitting} onClick={() => setDefinitionMode('create-workflow')}>
            <Icon name="node-tree" className="size-4" />
            {t('settings.piarium.agents.definition.createWorkflow')}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={catalogLoading} onClick={() => void refreshCatalog()}>
            <Icon name="refresh" className={catalogLoading ? 'size-4 animate-spin' : 'size-4'} />
            {t('settings.piarium.recovery.actions.refresh')}
          </Button>
        </div>
        {catalogError ? <p className="break-words typography-meta text-[var(--status-error)]">{catalogError}</p> : null}
        {agents.length > 0 ? (
          <SettingsFieldRow
            label={tx('settings.piarium.pluginSettings.subagents.catalog.select')}
            info={tx('settings.piarium.pluginSettings.subagents.catalog.description')}
          >
            <Select value={selectedId ?? ''} disabled={catalogLoading} onValueChange={setSelectedId}>
              <SelectTrigger
                size="settings"
                className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
                aria-label={tx('settings.piarium.pluginSettings.subagents.catalog.select')}
              >
                <SelectValue>
                  {selectedAgent
                    ? `${selectedAgent.name} · ${tx(`settings.piarium.pluginSettings.subagents.kind.${selectedAgent.kind}`)}`
                    : undefined}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name} · {tx(`settings.piarium.pluginSettings.subagents.kind.${agent.kind}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsFieldRow>
        ) : catalog && !catalogLoading ? (
          <p className="typography-meta text-muted-foreground">
            {tx('settings.piarium.pluginSettings.subagents.catalog.empty')}
          </p>
        ) : null}

        {selectedAgent ? (
          <div className="space-y-4 border-t border-border/60 pt-4">
            <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
              <div className="min-w-0">
                <h4 className="typography-settings-group-title text-foreground">{selectedAgent.name}</h4>
                <p className="mt-1 typography-meta text-muted-foreground">{selectedAgent.description}</p>
              </div>
              {selectedAgent.actions.some((action) => action.id === 'update') ? (
                <Button type="button" variant="outline" size="sm" disabled={submitting} onClick={() => setDefinitionMode(selectedAgent.kind === 'workflow' ? 'update-workflow' : 'update-agent')}>
                  <Icon name="edit" className="size-4" />
                  {selectedAgent.kind === 'workflow'
                    ? t('settings.piarium.agents.definition.editWorkflow')
                    : t('settings.piarium.agents.definition.editAgent')}
                </Button>
              ) : null}
            </div>
            <dl className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
              <div><dt className="typography-micro text-muted-foreground">{t('settings.piarium.agents.detail.kind')}</dt><dd className="typography-meta text-foreground">{tx(`settings.piarium.pluginSettings.subagents.kind.${selectedAgent.kind}`)}</dd></div>
              <div><dt className="typography-micro text-muted-foreground">{t('settings.piarium.agents.detail.source')}</dt><dd className="typography-meta text-foreground">{tx(`settings.piarium.pluginSettings.subagents.scope.${selectedAgent.source.scope}`)}</dd></div>
              <div><dt className="typography-micro text-muted-foreground">{tx('settings.piarium.pluginSettings.subagents.definition.status')}</dt><dd className="typography-meta text-foreground">{tx(`settings.piarium.pluginSettings.subagents.status.${selectedAgent.status}`)}</dd></div>
              <div><dt className="typography-micro text-muted-foreground">{t('settings.piarium.agents.detail.provider')}</dt><dd className="typography-meta text-foreground">{provider?.label ?? selectedAgent.providerId}</dd></div>
              <div><dt className="typography-micro text-muted-foreground">{t('settings.piarium.agents.detail.model')}</dt><dd className="typography-meta text-foreground">{selectedAgent.model ?? t('settings.piarium.agents.detail.inherited')}</dd></div>
              {selectedAgent.thinking ? <div><dt className="typography-micro text-muted-foreground">{t('settings.piarium.agents.detail.thinking')}</dt><dd className="typography-meta text-foreground">{isSupportedPiSubagentsThinking(selectedAgent.thinking) ? tx(`settings.piarium.pluginSettings.subagents.thinking.${selectedAgent.thinking}`) : t('settings.piarium.pluginSettings.field.unsupportedValue')}</dd></div> : null}
              <div><dt className="typography-micro text-muted-foreground">{tx('settings.piarium.pluginSettings.subagents.definition.actions')}</dt><dd className="typography-meta text-foreground">{selectedAgent.actions.map((action) => actionLabel(action, selectedAgent.kind)).join(', ') || tx('settings.piarium.pluginSettings.subagents.value.none')}</dd></div>
            </dl>
          </div>
        ) : null}
        {actionMessage?.message ? (
          <p className={actionMessage.success ? 'typography-meta text-[var(--status-success)]' : 'typography-meta text-[var(--status-error)]'}>
            {actionMessage.message}
          </p>
        ) : null}
      </SettingsControlGroup>

      {selectedAgent?.kind === 'workflow' ? null : (
        <SettingsControlGroup
          className="border-t border-border/60 pt-5"
          title={tx(scope === 'project'
            ? 'settings.piarium.pluginSettings.subagents.overrides.projectTitle'
            : 'settings.piarium.pluginSettings.subagents.overrides.userTitle')}
          description={t('settings.piarium.pluginSettings.subagents.overrides.description')}
          contentClassName="space-y-5"
        >
          <PluginRuntimeNote>
            {t('settings.piarium.pluginSettings.subagents.overrides.precedence')}
          </PluginRuntimeNote>
          <div className="flex flex-col gap-2 @xl:flex-row @xl:items-end">
            <div className="min-w-0 flex-1 space-y-1.5">
              <label className="typography-settings-field-label text-foreground" htmlFor={`${listId}-input`}>
                {t('settings.piarium.pluginSettings.subagents.overrides.runtimeName')}
              </label>
              <Input id={`${listId}-input`} list={listId} value={nameInput} disabled={disabled} placeholder="reviewer" onChange={(event) => setNameInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); selectOverride(); } }} />
              <datalist id={listId}>{overrideNames.map((name) => <option key={name} value={name} />)}</datalist>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" disabled={disabled || !nameInput.trim()} onClick={selectOverride}>{t('settings.piarium.pluginSettings.subagents.overrides.edit')}</Button>
              <Button type="button" variant="ghost" size="sm" disabled={disabled || !hasOverride} onClick={() => onRemove(selectedPath)} className="text-[var(--status-error)]">{t('settings.piarium.recovery.actions.remove')}</Button>
            </div>
          </div>
          {selectedOverrideName ? (
            <div className="space-y-5 border-t border-border/60 pt-4">
              <div className="min-w-0">
                <div className="typography-ui-label font-medium text-foreground">{selectedOverrideName}</div>
                <p className="mt-1 typography-meta text-muted-foreground">{selectedOverrideAgent?.description ?? t('settings.piarium.pluginSettings.subagents.overrides.customName')}</p>
              </div>
              <SettingsControlGroup title={tx('settings.piarium.pluginSettings.subagents.overrides.modelSection')} contentClassName="space-y-4">
                <OverrideModelField {...fieldProps} path={[...selectedPath, 'model']} label={tx('settings.piarium.pluginSettings.subagents.field.primaryModel')} placeholder={tx('settings.piarium.pluginSettings.subagents.value.inheritModel')} />
                <OverrideThinkingField {...fieldProps} path={[...selectedPath, 'thinking']} label={tx('settings.piarium.pluginSettings.subagents.field.thinkingLevel')} />
                <OverrideListOrClearField {...fieldProps} path={[...selectedPath, 'fallbackModels']} label={tx('settings.piarium.pluginSettings.subagents.field.fallbackModels')} placeholder="provider/model" />
              </SettingsControlGroup>
              <SettingsControlGroup className="border-t border-border/60 pt-4" title={tx('settings.piarium.pluginSettings.subagents.overrides.capabilitiesSection')} contentClassName="space-y-4">
                <OverrideAvailabilityField {...fieldProps} path={[...selectedPath, 'disabled']} label={tx('settings.piarium.pluginSettings.subagents.field.agentAvailability')} />
                <PluginOptionalSelectField {...fieldProps} path={[...selectedPath, 'defaultContext']} label={tx('settings.piarium.pluginSettings.subagents.field.defaultContext')} options={[
                  { value: 'fresh', label: tx('settings.piarium.pluginSettings.subagents.context.fresh') },
                  { value: 'fork', label: tx('settings.piarium.pluginSettings.subagents.context.fork') },
                  { value: false, label: t('settings.piarium.pluginSettings.subagents.overrides.mode.clear') },
                ]} />
                <PluginOptionalBooleanField {...fieldProps} path={[...selectedPath, 'inheritProjectContext']} label={tx('settings.piarium.pluginSettings.subagents.field.inheritProjectContext')} />
                <PluginOptionalBooleanField {...fieldProps} path={[...selectedPath, 'inheritSkills']} label={tx('settings.piarium.pluginSettings.subagents.field.inheritSkills')} />
                <OverrideListOrClearField {...fieldProps} path={[...selectedPath, 'tools']} label={tx('settings.piarium.pluginSettings.subagents.field.allowedTools')} placeholder="read" />
                <OverrideListOrClearField {...fieldProps} path={[...selectedPath, 'skills']} label={tx('settings.piarium.pluginSettings.subagents.field.skills')} placeholder="skill-name" />
                <OverrideListOrClearField {...fieldProps} path={[...selectedPath, 'extensions']} label={tx('settings.piarium.pluginSettings.subagents.field.extensions')} placeholder="extension/path.ts" />
                <OverrideListOrClearField {...fieldProps} path={[...selectedPath, 'subagentOnlyExtensions']} label={tx('settings.piarium.pluginSettings.subagents.field.subagentExtensions')} placeholder="extension/path.ts" />
                <PluginOptionalSelectField {...fieldProps} path={[...selectedPath, 'acceptanceRole']} label={tx('settings.piarium.pluginSettings.subagents.field.acceptanceRole')} options={[
                  { value: 'read-only', label: tx('settings.piarium.pluginSettings.subagents.acceptance.readOnly') },
                  { value: 'writer', label: tx('settings.piarium.pluginSettings.subagents.acceptance.writer') },
                  { value: false, label: t('settings.piarium.pluginSettings.subagents.overrides.mode.clear') },
                ]} />
                <PluginOptionalBooleanField {...fieldProps} path={[...selectedPath, 'completionGuard']} label={tx('settings.piarium.pluginSettings.subagents.field.completionGuard')} />
                <OverrideToolBudgetField {...fieldProps} path={[...selectedPath, 'toolBudget']} label={tx('settings.piarium.pluginSettings.subagents.field.toolBudget')} />
              </SettingsControlGroup>
            </div>
          ) : null}
        </SettingsControlGroup>
      )}

      <PiSubagentsDefinitionDialog
        open={definitionMode !== null}
        mode={definitionMode}
        agent={definitionAgent}
        projectTrusted={catalog?.projectTrusted ?? false}
        submitting={submitting}
        onOpenChange={(open) => { if (!open) setDefinitionMode(null); }}
        onSubmit={submitDefinition}
      />
    </div>
  );
};
