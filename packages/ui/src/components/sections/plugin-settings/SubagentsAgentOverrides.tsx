import React from 'react';
import type {
  JsonValue,
  PiAgentCatalogSnapshot,
  PiAgentDescriptor,
  RuntimeContextTarget,
} from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
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
import { listPiAgentProviders } from '@/lib/pi-runtime/agent-providers';
import {
  PluginOptionalBooleanField,
  PluginOptionalSelectField,
  PluginTextareaField,
} from './PluginConfigFields';
import {
  asJsonObject,
  hasJsonPath,
  readJsonPath,
  validStringArray,
  type JsonObject,
} from './plugin-config-model';

interface SubagentsAgentOverridesProps {
  disabled: boolean;
  draft: JsonObject;
  onRemove: (path: readonly string[]) => void;
  onSet: (path: readonly string[], value: JsonValue) => void;
  runtimeTarget: RuntimeContextTarget;
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

const OVERRIDABLE_LIST_FIELDS = [
  ['fallbackModels', 'provider/model'],
  ['tools', 'read'],
  ['skills', 'skill-name'],
  ['extensions', 'extension/path.ts'],
  ['subagentOnlyExtensions', 'extension/path.ts'],
] as const;

const descriptorForName = (
  catalog: PiAgentCatalogSnapshot | null,
  name: string,
): PiAgentDescriptor | undefined => catalog?.agents.find((agent) => (
  agent.providerId === 'pi-subagents'
  && agent.kind === 'delegatable'
  && agent.name === name
));

const OverrideStringOrClearField: React.FC<OverrideFieldProps> = ({
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
          <SelectTrigger size="settings" className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={`${label} mode`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">{t('settings.piarium.pluginSettings.subagents.overrides.mode.inherit')}</SelectItem>
            <SelectItem value="clear">{t('settings.piarium.pluginSettings.subagents.overrides.mode.clear')}</SelectItem>
            <SelectItem value="override">{t('settings.piarium.pluginSettings.subagents.overrides.mode.override')}</SelectItem>
          </SelectContent>
        </Select>
        {mode === 'override' ? (
          <Input
            value={typeof raw === 'string' ? raw : ''}
            disabled={disabled}
            placeholder={placeholder}
            aria-label={label}
            onChange={(event) => onSet(path, event.target.value)}
            className="min-w-0 flex-1"
          />
        ) : null}
      </div>
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
          <SelectTrigger size="settings" className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={`${label} mode`}>
            <SelectValue />
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
  const raw = readJsonPath(draft, path);
  const budget = asJsonObject(raw);
  const mode = raw === false ? 'clear' : budget ? 'override' : 'inherit';
  const block = budget?.block;
  const blockList = validStringArray(block);
  const blockMode = block === '*' ? 'all' : blockList ? 'list' : 'default';

  return (
    <div className="space-y-3 rounded-md border border-border/60 px-3 py-3">
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
          <SelectTrigger size="settings" className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={`${label} mode`}>
            <SelectValue />
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
          <SettingsFieldRow label="hard" controlClassName="w-full max-w-lg">
            <NumberInput
              value={typeof budget?.hard === 'number' ? budget.hard : undefined}
              fallbackValue={16}
              disabled={disabled}
              min={1}
              step={1}
              onValueChange={(value) => onSet([...path, 'hard'], value)}
              containerClassName="w-36"
              aria-label={`${label}.hard`}
            />
          </SettingsFieldRow>
          <SettingsFieldRow label="soft" controlClassName="w-full max-w-lg">
            <NumberInput
              value={typeof budget?.soft === 'number' ? budget.soft : undefined}
              fallbackValue={10}
              disabled={disabled}
              min={1}
              step={1}
              onClear={() => onRemove([...path, 'soft'])}
              onValueChange={(value) => onSet([...path, 'soft'], value)}
              containerClassName="w-36"
              emptyLabel={t('settings.piarium.pluginSettings.field.pluginDefault')}
              aria-label={`${label}.soft`}
            />
          </SettingsFieldRow>
          <SettingsFieldRow label="block" alignEnd={false} controlClassName="w-full max-w-lg items-start">
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
                <SelectTrigger size="settings" className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={`${label}.block mode`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">{t('settings.piarium.pluginSettings.field.pluginDefault')}</SelectItem>
                  <SelectItem value="all">*</SelectItem>
                  <SelectItem value="list">{t('settings.piarium.pluginSettings.subagents.overrides.mode.override')}</SelectItem>
                </SelectContent>
              </Select>
              {blockMode === 'list' ? (
                <Textarea
                  value={(blockList ?? []).join('\n')}
                  disabled={disabled}
                  placeholder={'read\ngrep\nfind\nls'}
                  aria-label={`${label}.block`}
                  onChange={(event) => onSet(
                    [...path, 'block'],
                    event.target.value
                      .split(/\r?\n/)
                      .map((entry) => entry.trim())
                      .filter(Boolean),
                  )}
                  className="min-h-20 min-w-0 flex-1 font-mono"
                />
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
  targetKey,
}) => {
  const { t } = useI18n();
  const [catalog, setCatalog] = React.useState<PiAgentCatalogSnapshot | null>(null);
  const [catalogError, setCatalogError] = React.useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = React.useState(false);
  const [nameInput, setNameInput] = React.useState('');
  const [selectedName, setSelectedName] = React.useState('');
  const listId = React.useId();

  const refreshCatalog = React.useCallback(async (): Promise<void> => {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      setCatalog(await listPiAgentProviders(runtimeTarget));
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : String(error));
    } finally {
      setCatalogLoading(false);
    }
  }, [runtimeTarget]);

  React.useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog, targetKey]);

  const overrides = asJsonObject(readJsonPath(draft, ['agentOverrides']));
  const knownNames = React.useMemo(() => [...new Set([
    ...Object.keys(overrides),
    ...(catalog?.agents
      .filter((agent) => agent.providerId === 'pi-subagents' && agent.kind === 'delegatable')
      .map((agent) => agent.name) ?? []),
  ])].sort((left, right) => left.localeCompare(right)), [catalog?.agents, overrides]);

  React.useEffect(() => {
    if (selectedName || knownNames.length === 0) return;
    const first = knownNames[0] ?? '';
    setSelectedName(first);
    setNameInput(first);
  }, [knownNames, selectedName]);

  const selectedAgent = descriptorForName(catalog, selectedName);
  const selectedPath = ['agentOverrides', selectedName] as const;
  const hasOverride = Boolean(selectedName) && hasJsonPath(draft, selectedPath);
  const fieldProps = {
    disabled: disabled || !selectedName,
    draft,
    onRemove,
    onSet,
  };

  const selectAgent = (): void => {
    const name = nameInput.trim();
    if (name) setSelectedName(name);
  };

  return (
    <SettingsControlGroup
      className="border-t border-border/60 pt-5"
      title={t('settings.piarium.pluginSettings.subagents.overrides.title')}
      description={t('settings.piarium.pluginSettings.subagents.overrides.description')}
      contentClassName="space-y-5"
    >
      <p className="rounded-md bg-[var(--surface-elevated)] px-3 py-2 typography-meta text-muted-foreground">
        {t('settings.piarium.pluginSettings.subagents.overrides.precedence')}
      </p>

      <div className="flex flex-col gap-2 @xl:flex-row @xl:items-end">
        <div className="min-w-0 flex-1 space-y-1.5">
          <label className="typography-settings-field-label text-foreground" htmlFor={`${listId}-input`}>
            {t('settings.piarium.pluginSettings.subagents.overrides.runtimeName')}
          </label>
          <Input
            id={`${listId}-input`}
            list={listId}
            value={nameInput}
            disabled={disabled}
            placeholder="reviewer"
            onChange={(event) => setNameInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              selectAgent();
            }}
          />
          <datalist id={listId}>
            {knownNames.map((name) => <option key={name} value={name} />)}
          </datalist>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={disabled || !nameInput.trim()} onClick={selectAgent}>
            {t('settings.piarium.pluginSettings.subagents.overrides.edit')}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={catalogLoading} onClick={() => void refreshCatalog()}>
            <Icon name="refresh" className={catalogLoading ? 'size-4 animate-spin' : 'size-4'} />
            {t('settings.piarium.recovery.actions.refresh')}
          </Button>
        </div>
      </div>

      {catalogError ? (
        <p className="break-words typography-meta text-[var(--status-error)]">{catalogError}</p>
      ) : null}

      {selectedName ? (
        <div className="space-y-5 rounded-lg border border-border/60 px-3 py-3">
          <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <code className="typography-ui-label text-foreground">{selectedName}</code>
                {selectedAgent ? (
                  <>
                    <span className="rounded-full border border-border/60 px-2 py-0.5 typography-micro text-muted-foreground">
                      {selectedAgent.source.scope}
                    </span>
                    <span className="rounded-full border border-border/60 px-2 py-0.5 typography-micro text-muted-foreground">
                      {selectedAgent.status}
                    </span>
                    {selectedAgent.model ? (
                      <span className="rounded-full border border-border/60 px-2 py-0.5 typography-micro text-muted-foreground">
                        {selectedAgent.model}
                      </span>
                    ) : null}
                    {selectedAgent.thinking ? (
                      <span className="rounded-full border border-border/60 px-2 py-0.5 typography-micro text-muted-foreground">
                        {selectedAgent.thinking}
                      </span>
                    ) : null}
                  </>
                ) : null}
              </div>
              <p className="typography-meta text-muted-foreground">
                {selectedAgent?.description
                  ?? t('settings.piarium.pluginSettings.subagents.overrides.customName')}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={disabled || !hasOverride}
              onClick={() => onRemove(selectedPath)}
              className="shrink-0 !font-normal text-[var(--status-error)]"
            >
              {t('settings.piarium.recovery.actions.remove')}
            </Button>
          </div>

          <div className="space-y-4 border-t border-border/60 pt-4">
            <OverrideStringOrClearField {...fieldProps} path={[...selectedPath, 'model']} label="model" placeholder="provider/model" />
            <OverrideListOrClearField {...fieldProps} path={[...selectedPath, 'fallbackModels']} label="fallbackModels" placeholder="provider/model" />
            <OverrideStringOrClearField {...fieldProps} path={[...selectedPath, 'thinking']} label="thinking" placeholder="off | minimal | low | medium | high | xhigh | max" />
            <PluginOptionalSelectField
              {...fieldProps}
              path={[...selectedPath, 'systemPromptMode']}
              label="systemPromptMode"
              options={[
                { value: 'append', label: 'append' },
                { value: 'replace', label: 'replace' },
              ]}
            />
            <PluginOptionalBooleanField {...fieldProps} path={[...selectedPath, 'inheritProjectContext']} label="inheritProjectContext" />
            <PluginOptionalBooleanField {...fieldProps} path={[...selectedPath, 'inheritSkills']} label="inheritSkills" />
            <PluginOptionalSelectField
              {...fieldProps}
              path={[...selectedPath, 'defaultContext']}
              label="defaultContext"
              options={[
                { value: 'fresh', label: 'fresh' },
                { value: 'fork', label: 'fork' },
                { value: false, label: t('settings.piarium.pluginSettings.subagents.overrides.mode.clear') },
              ]}
            />
            <PluginOptionalSelectField
              {...fieldProps}
              path={[...selectedPath, 'acceptanceRole']}
              label="acceptanceRole"
              options={[
                { value: 'read-only', label: 'read-only' },
                { value: 'writer', label: 'writer' },
                { value: false, label: t('settings.piarium.pluginSettings.subagents.overrides.mode.clear') },
              ]}
            />
            <PluginOptionalBooleanField {...fieldProps} path={[...selectedPath, 'disabled']} label="disabled" />
            <PluginOptionalBooleanField {...fieldProps} path={[...selectedPath, 'completionGuard']} label="completionGuard" />
            {OVERRIDABLE_LIST_FIELDS.slice(1).map(([field, placeholder]) => (
              <OverrideListOrClearField
                key={field}
                {...fieldProps}
                path={[...selectedPath, field]}
                label={field}
                placeholder={placeholder}
              />
            ))}
            <OverrideToolBudgetField
              {...fieldProps}
              path={[...selectedPath, 'toolBudget']}
              label="toolBudget"
            />
            <PluginTextareaField
              {...fieldProps}
              path={[...selectedPath, 'systemPrompt']}
              label="systemPrompt"
              description={t('settings.piarium.pluginSettings.subagents.overrides.systemPromptBuiltinOnly')}
              placeholder="Additional or replacement system prompt for builtin agents"
            />
          </div>

          <p className="typography-meta text-muted-foreground">
            {t('settings.piarium.pluginSettings.subagents.overrides.advancedNote')}
          </p>
        </div>
      ) : null}
    </SettingsControlGroup>
  );
};
