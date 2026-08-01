import React from 'react';
import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowUpSLine,
  RiCodeLine,
  RiDeleteBinLine,
  RiEditLine,
  RiPlugLine,
  RiRefreshLine,
  RiRestartLine,
  RiSaveLine,
} from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { useConfigStore } from '@/stores/useConfigStore';
import { useOpenAgentConfigStore, type OpenAgentConfigItem } from '@/stores/useOpenAgentConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  OPEN_AGENT_AGENT_DEFINITIONS,
  OPEN_AGENT_CATEGORY_DEFINITIONS,
  OPEN_AGENT_TOP_LEVEL_ARRAY_KEYS,
  OPEN_AGENT_TOP_LEVEL_OBJECT_KEYS,
  buildOpenAgentSavePayload,
  countFallbackModels,
  fallbackModelsToRows,
  fallbackRowsToConfig,
  hasOpenAgentDraftChanges,
  joinModelRef,
  normalizeOpenAgentRecord,
  parseModelRef,
  type OpenAgentDraft,
  type OpenAgentFallbackRow,
  type OpenAgentKind,
  type OpenAgentOverride,
  type OpenAgentTopLevelArrayKey,
} from './openAgentConfig';

const INHERIT_VALUE = '__inherit__';
const REASONING_OPTIONS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const TEXT_VERBOSITY_OPTIONS = ['low', 'medium', 'high'];
const THINKING_OPTIONS = ['enabled', 'disabled'];

type JsonFieldState = {
  text: string;
  error: string | null;
};

type JsonValidationContextValue = {
  jsonFieldStates: Record<string, JsonFieldState>;
  resetVersion: number;
  setJsonFieldState: (id: string, state: JsonFieldState | null) => void;
};

const JsonValidationContext = React.createContext<JsonValidationContextValue>({
  jsonFieldStates: {},
  resetVersion: 0,
  setJsonFieldState: () => undefined,
});

const CONTINUATION_HOOKS = [
  {
    id: 'todo-continuation-enforcer',
    labelKey: 'settings.openagent.continuation.todo.label',
    descriptionKey: 'settings.openagent.continuation.todo.description',
  },
  {
    id: 'atlas',
    labelKey: 'settings.openagent.continuation.atlas.label',
    descriptionKey: 'settings.openagent.continuation.atlas.description',
  },
  {
    id: 'stop-continuation-guard',
    labelKey: 'settings.openagent.continuation.stopGuard.label',
    descriptionKey: 'settings.openagent.continuation.stopGuard.description',
  },
  {
    id: 'compaction-todo-preserver',
    labelKey: 'settings.openagent.continuation.compactionPreserver.label',
    descriptionKey: 'settings.openagent.continuation.compactionPreserver.description',
  },
] as const;

const DEFAULT_MODE_OPTIONS = ['ultrawork', 'ralph-loop'];

const GLOBAL_ARRAY_FIELDS: Array<{
  key: OpenAgentTopLevelArrayKey;
  labelKey: I18nKey;
  descriptionKey: I18nKey;
  placeholder: string;
}> = [
  {
    key: 'disabled_providers',
    labelKey: 'settings.openagent.global.disabledProviders.label',
    descriptionKey: 'settings.openagent.global.disabledProviders.description',
    placeholder: 'provider-id, github-copilot',
  },
  {
    key: 'disabled_skills',
    labelKey: 'settings.openagent.global.disabledSkills.label',
    descriptionKey: 'settings.openagent.global.disabledSkills.description',
    placeholder: 'skill-id, another-skill',
  },
  {
    key: 'disabled_commands',
    labelKey: 'settings.openagent.global.disabledCommands.label',
    descriptionKey: 'settings.openagent.global.disabledCommands.description',
    placeholder: 'command-name, another-command',
  },
  {
    key: 'disabled_tools',
    labelKey: 'settings.openagent.global.disabledTools.label',
    descriptionKey: 'settings.openagent.global.disabledTools.description',
    placeholder: 'bash, edit, webfetch',
  },
  {
    key: 'disabled_mcps',
    labelKey: 'settings.openagent.global.disabledMcps.label',
    descriptionKey: 'settings.openagent.global.disabledMcps.description',
    placeholder: 'context7, websearch',
  },
  {
    key: 'mcp_env_allowlist',
    labelKey: 'settings.openagent.global.mcpEnvAllowlist.label',
    descriptionKey: 'settings.openagent.global.mcpEnvAllowlist.description',
    placeholder: 'GITHUB_TOKEN, TAVILY_API_KEY',
  },
];

type OpenAgentGroup = 'main' | 'sub' | 'category' | 'custom';

type OpenAgentDisplayItem = {
  id: string;
  label: string;
  description: string;
  group: OpenAgentGroup;
  defaultModel?: string | null;
  defaultVariant?: string | null;
};

type EditingTarget = {
  kind: OpenAgentKind;
  id: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const getRecordValue = (value: unknown): Record<string, unknown> => (
  isRecord(value) ? value : {}
);

const isEmptyObject = (value: Record<string, unknown>): boolean => Object.keys(value).length === 0;

const setObjectField = (value: unknown, key: string, nextValue: unknown): Record<string, unknown> | undefined => {
  const next = { ...getRecordValue(value) };
  if (nextValue === undefined || nextValue === null || nextValue === '') {
    delete next[key];
  } else {
    next[key] = nextValue;
  }
  return isEmptyObject(next) ? undefined : next;
};

const setNestedObjectField = (value: unknown, key: string, nestedKey: string, nextValue: unknown): Record<string, unknown> | undefined => {
  const root = { ...getRecordValue(value) };
  const child = { ...getRecordValue(root[key]) };
  if (nextValue === undefined || nextValue === null || nextValue === '') {
    delete child[nestedKey];
  } else {
    child[nestedKey] = nextValue;
  }
  if (isEmptyObject(child)) delete root[key];
  else root[key] = child;
  return isEmptyObject(root) ? undefined : root;
};

const getFieldNumber = (value: unknown, key: string): string => {
  const fieldValue = getRecordValue(value)[key];
  return typeof fieldValue === 'number' && Number.isFinite(fieldValue) ? String(fieldValue) : '';
};

const getNestedFieldNumber = (value: unknown, key: string, nestedKey: string): string => {
  const fieldValue = getRecordValue(getRecordValue(value)[key])[nestedKey];
  return typeof fieldValue === 'number' && Number.isFinite(fieldValue) ? String(fieldValue) : '';
};

const parseOptionalNumber = (value: string): number | undefined => {
  if (!value.trim()) return undefined;
  const next = Number(value);
  return Number.isFinite(next) ? next : undefined;
};

const asString = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : String(value);
};

const getDraftRecord = (draft: OpenAgentDraft, kind: OpenAgentKind) => (
  kind === 'agent' ? draft.agents : draft.categories
);

const toDisplayItems = (items: OpenAgentConfigItem[] | undefined, kind: OpenAgentKind): OpenAgentDisplayItem[] => {
  if (items && items.length > 0) {
    return items.map((item) => ({
      id: item.id,
      label: item.label,
      description: item.description,
      group: item.group,
      defaultModel: item.defaultModel,
      defaultVariant: item.defaultVariant,
    }));
  }

  const source = kind === 'agent' ? OPEN_AGENT_AGENT_DEFINITIONS : OPEN_AGENT_CATEGORY_DEFINITIONS;
  return source.map((item) => ({
    id: item.id,
    label: item.label,
    description: item.description,
    group: item.group,
    defaultModel: item.defaultModel ?? null,
    defaultVariant: item.defaultVariant ?? null,
  }));
};

const buildDisplayItems = (
  configItems: OpenAgentConfigItem[] | undefined,
  kind: OpenAgentKind,
  draft: OpenAgentDraft,
  projectOverrides: string[],
  customUnknownDescription: string,
): OpenAgentDisplayItem[] => {
  const base = toDisplayItems(configItems, kind);
  const knownIds = new Set(base.map((item) => item.id));
  const record = getDraftRecord(draft, kind);
  const customIds = Array.from(new Set([
    ...Object.keys(record),
    ...projectOverrides,
  ]))
    .filter((id) => id.trim() && !knownIds.has(id))
    .sort();

  return [
    ...base,
    ...customIds.map((id) => ({
      id,
      label: id,
      description: customUnknownDescription,
      group: 'custom' as const,
      defaultModel: null,
      defaultVariant: null,
    })),
  ];
};

const formatDefaultModel = (item: OpenAgentDisplayItem, pluginDefaultLabel: string): string => {
  if (!item.defaultModel) return pluginDefaultLabel;
  return item.defaultVariant ? `${item.defaultModel} · ${item.defaultVariant}` : item.defaultModel;
};

const getEntry = (draft: OpenAgentDraft, kind: OpenAgentKind, id: string): OpenAgentOverride => (
  getDraftRecord(draft, kind)[id] ?? {}
);

const getItemStatus = (
  entry: OpenAgentOverride,
  hasUserOverride: boolean,
  hasProjectOverride: boolean,
  labels: { disabled: string; overridden: string; projectOverride: string; inherited: string },
): { label: string; className: string } => {
  if (entry.disable === true) {
    return { label: labels.disabled, className: 'bg-[var(--status-error)]/10 text-[var(--status-error)]' };
  }
  if (hasUserOverride) {
    return { label: labels.overridden, className: 'bg-primary/10 text-primary' };
  }
  if (hasProjectOverride) {
    return { label: labels.projectOverride, className: 'bg-[var(--status-warning)]/10 text-[var(--status-warning)]' };
  }
  return { label: labels.inherited, className: 'bg-muted text-muted-foreground' };
};

const normalizeCustomId = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '-');

const normalizeHookList = (hooks: string[] | undefined): string[] => (
  Array.from(new Set((hooks ?? []).map((hook) => hook.trim()).filter(Boolean))).sort()
);

const formatStringList = (values: unknown): string => (
  Array.isArray(values) ? values.map((value) => asString(value).trim()).filter(Boolean).join(', ') : ''
);

const parseStringList = (value: string): string[] | undefined => {
  const entries = Array.from(new Set(value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)))
    .sort();
  return entries.length > 0 ? entries : undefined;
};

const formatStringOnlyList = (values: unknown): string => (
  Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean).join(', ') : ''
);

const formatNumberList = (values: unknown): string => (
  Array.isArray(values) ? values.map((value) => typeof value === 'number' ? String(value) : '').filter(Boolean).join(', ') : ''
);

const parseNumberList = (value: string): number[] | undefined => {
  const entries = Array.from(new Set(value
    .split(/[\n,]/)
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry))))
    .sort((a, b) => a - b);
  return entries.length > 0 ? entries : undefined;
};

function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex h-5 shrink-0 items-center rounded px-1.5 typography-micro font-medium', className)}>
      {children}
    </span>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="typography-ui-label text-foreground">{label}</span>
      {children}
      {hint ? <span className="typography-micro text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

function TriStateBooleanSelect({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (value: boolean | undefined) => void;
}) {
  const { t } = useI18n();
  const selectValue = typeof value === 'boolean' ? String(value) : INHERIT_VALUE;

  return (
    <Select
      value={selectValue}
      onValueChange={(nextValue) => onChange(nextValue === INHERIT_VALUE ? undefined : nextValue === 'true')}
    >
      <SelectTrigger className="h-8 w-full" size="sm">
        <SelectValue>{(currentValue) => currentValue === INHERIT_VALUE ? t('settings.openagent.model.inherit') : currentValue}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={INHERIT_VALUE}>{t('settings.openagent.model.inherit')}</SelectItem>
        <SelectItem value="true">true</SelectItem>
        <SelectItem value="false">false</SelectItem>
      </SelectContent>
    </Select>
  );
}

function CompactModelEditor({
  model,
  onChange,
  placeholder,
}: {
  model: string;
  onChange: (model: string) => void;
  placeholder?: string;
}) {
  const { t } = useI18n();
  const parsed = parseModelRef(model);
  const selectorPlaceholder = placeholder ?? t('settings.openagent.model.inheritDefault');

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <ModelSelector
        providerId={parsed.providerId}
        modelId={parsed.modelId}
        onChange={(providerId, modelId) => onChange(joinModelRef(providerId, modelId))}
        placeholder={selectorPlaceholder}
        className="h-7 min-w-[120px] max-w-[210px] flex-1"
      />
      <Input
        value={model}
        onChange={(event) => onChange(event.target.value)}
        placeholder="provider/model"
        className="h-7 min-w-[140px] flex-1 font-mono typography-meta"
      />
    </div>
  );
}

function JsonTextareaField({
  validationId,
  label,
  value,
  onChange,
  placeholder,
}: {
  validationId: string;
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
  placeholder?: string;
}) {
  const { t } = useI18n();
  const { jsonFieldStates, resetVersion, setJsonFieldState } = React.useContext(JsonValidationContext);
  const persistedState = jsonFieldStates[validationId];
  const [text, setText] = React.useState(() => (
    persistedState?.text ?? (value === undefined || value === null ? '' : JSON.stringify(value, null, 2))
  ));
  const [error, setError] = React.useState<string | null>(persistedState?.error ?? null);
  const skipNextValueSyncRef = React.useRef(false);

  React.useEffect(() => {
    if (persistedState) {
      setText(persistedState.text);
      setError(persistedState.error);
      return;
    }
    if (skipNextValueSyncRef.current) {
      skipNextValueSyncRef.current = false;
      return;
    }
    setText(value === undefined || value === null ? '' : JSON.stringify(value, null, 2));
    setError(null);
  }, [persistedState, resetVersion, validationId, value]);

  const validateAndCommit = (nextText: string) => {
    const trimmed = nextText.trim();
    if (!trimmed) {
      setError(null);
      setJsonFieldState(validationId, null);
      skipNextValueSyncRef.current = true;
      onChange(undefined);
      return;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (!isRecord(parsed)) {
        const nextError = t('settings.openagent.validation.jsonObjectRequired');
        setError(nextError);
        setJsonFieldState(validationId, { text: nextText, error: nextError });
        return;
      }
      setError(null);
      setJsonFieldState(validationId, null);
      skipNextValueSyncRef.current = true;
      onChange(parsed);
    } catch {
      const nextError = t('settings.openagent.validation.jsonInvalid');
      setError(nextError);
      setJsonFieldState(validationId, { text: nextText, error: nextError });
    }
  };

  const updateText = (nextText: string) => {
    setText(nextText);
    validateAndCommit(nextText);
  };

  return (
    <Field label={label} hint={error ?? placeholder}>
      <Textarea
        value={text}
        onChange={(event) => updateText(event.target.value)}
        rows={4}
        outerClassName={cn('min-h-[112px]', error && 'ring-[var(--status-error)]')}
        className="font-mono typography-meta"
        placeholder="{ }"
      />
    </Field>
  );
}

function RuntimeFallbackField({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { t } = useI18n();
  const { setJsonFieldState } = React.useContext(JsonValidationContext);
  const mode = typeof value === 'boolean' ? String(value) : isRecord(value) ? 'object' : INHERIT_VALUE;
  const validationId = 'global:runtime_fallback';
  const objectValue = getRecordValue(value);
  const updateObjectField = (key: string, nextValue: unknown) => onChange(setObjectField(objectValue, key, nextValue) ?? {});

  return (
    <div className="space-y-2">
      <Field label={t('settings.openagent.global.runtimeFallback.label')} hint={t('settings.openagent.global.runtimeFallback.description')}>
        <Select
          value={mode}
          onValueChange={(nextMode) => {
            if (nextMode === INHERIT_VALUE) {
              setJsonFieldState(validationId, null);
              onChange(undefined);
            } else if (nextMode === 'true') {
              setJsonFieldState(validationId, null);
              onChange(true);
            } else if (nextMode === 'false') {
              setJsonFieldState(validationId, null);
              onChange(false);
            }
            else onChange(isRecord(value) ? value : {});
          }}
        >
          <SelectTrigger className="h-8 w-full" size="sm">
            <SelectValue>{(currentValue) => currentValue === INHERIT_VALUE ? t('settings.openagent.model.inherit') : currentValue}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT_VALUE}>{t('settings.openagent.model.inherit')}</SelectItem>
            <SelectItem value="true">true</SelectItem>
            <SelectItem value="false">false</SelectItem>
            <SelectItem value="object">{t('settings.openagent.global.mode.structured')}</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      {isRecord(value) ? (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <BooleanObjectField value={objectValue.enabled} label="enabled" onChange={(nextValue) => updateObjectField('enabled', nextValue)} />
            <NumberObjectField value={getFieldNumber(objectValue, 'max_fallback_attempts')} label="max_fallback_attempts" min={1} max={20} onChange={(nextValue) => updateObjectField('max_fallback_attempts', nextValue)} />
            <NumberObjectField value={getFieldNumber(objectValue, 'cooldown_seconds')} label="cooldown_seconds" min={0} onChange={(nextValue) => updateObjectField('cooldown_seconds', nextValue)} />
            <NumberObjectField value={getFieldNumber(objectValue, 'timeout_seconds')} label="timeout_seconds" min={0} onChange={(nextValue) => updateObjectField('timeout_seconds', nextValue)} />
            <BooleanObjectField value={objectValue.notify_on_fallback} label="notify_on_fallback" onChange={(nextValue) => updateObjectField('notify_on_fallback', nextValue)} />
            <Field label="retry_on_errors" hint="429, 500, 502, 503, 504">
              <Input
                value={formatNumberList(objectValue.retry_on_errors)}
                onChange={(event) => updateObjectField('retry_on_errors', parseNumberList(event.target.value))}
                className="h-8 font-mono typography-meta"
                placeholder="429, 500, 502, 503, 504"
              />
            </Field>
          </div>
          <AdvancedJsonField
            validationId={validationId}
            label="runtime_fallback"
            value={value}
            onChange={onChange}
            placeholder='{ "enabled": true, "max_fallback_attempts": 3 }'
          />
        </>
      ) : null}
    </div>
  );
}

function BooleanObjectField({
  value,
  label,
  onChange,
}: {
  value: unknown;
  label: string;
  onChange: (value: boolean | undefined) => void;
}) {
  return (
    <Field label={label}>
      <TriStateBooleanSelect value={value} onChange={onChange} />
    </Field>
  );
}

function NumberObjectField({
  value,
  label,
  min,
  max,
  onChange,
}: {
  value: string;
  label: string;
  min?: number;
  max?: number;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <Field label={label}>
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange(parseOptionalNumber(event.target.value))}
        className="h-8 font-mono typography-meta"
      />
    </Field>
  );
}

function TextObjectField({
  value,
  label,
  placeholder,
  onChange,
}: {
  value: unknown;
  label: string;
  placeholder?: string;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <Field label={label}>
      <Input
        value={asString(value)}
        onChange={(event) => onChange(event.target.value || undefined)}
        placeholder={placeholder}
        className="h-8 font-mono typography-meta"
      />
    </Field>
  );
}

function AdvancedJsonField({
  validationId,
  label,
  value,
  onChange,
  placeholder,
}: {
  validationId: string;
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
  placeholder?: string;
}) {
  const { t } = useI18n();
  return (
    <Collapsible>
      <CollapsibleTrigger className="mt-1 rounded-md px-0 py-1 typography-ui-label text-muted-foreground hover:bg-transparent hover:text-foreground">
        <span>{t('settings.openagent.global.advancedJson')}</span>
        <RiArrowDownSLine className="h-4 w-4" />
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        <JsonTextareaField
          validationId={validationId}
          label={label}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

function AddCustomControl({
  kind,
  onAdd,
}: {
  kind: OpenAgentKind;
  onAdd: (kind: OpenAgentKind, id: string) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = React.useState('');

  const handleAdd = () => {
    const id = normalizeCustomId(value);
    if (!id) return;
    onAdd(kind, id);
    setValue('');
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            handleAdd();
          }
        }}
        placeholder={kind === 'agent' ? 'custom-agent-id' : 'custom-category-id'}
        className="h-7 min-w-[140px] flex-1 typography-meta sm:w-44 sm:flex-none"
      />
      <Button type="button" size="xs" variant="outline" onClick={handleAdd} disabled={!value.trim()}>
        <RiAddLine className="h-3.5 w-3.5" />
        {t('settings.openagent.actions.add')}
      </Button>
    </div>
  );
}

function OpenAgentRow({
  kind,
  item,
  draft,
  projectOverride,
  onEdit,
}: {
  kind: OpenAgentKind;
  item: OpenAgentDisplayItem;
  draft: OpenAgentDraft;
  projectOverride: boolean;
  onEdit: (target: EditingTarget) => void;
}) {
  const { t } = useI18n();
  const updateDraftItem = useOpenAgentConfigStore((state) => state.updateDraftItem);
  const resetItem = useOpenAgentConfigStore((state) => state.resetItem);
  const entry = getEntry(draft, kind, item.id);
  const normalizedRecord = normalizeOpenAgentRecord(kind, getDraftRecord(draft, kind));
  const normalizedEntry = normalizedRecord[item.id];
  const model = asString(entry.model);
  const fallbackCount = countFallbackModels(entry.fallback_models);
  const status = getItemStatus(entry, Boolean(normalizedEntry), projectOverride, {
    disabled: t('settings.openagent.badge.disabled'),
    overridden: t('settings.openagent.badge.overridden'),
    projectOverride: t('settings.openagent.badge.projectOverride'),
    inherited: t('settings.openagent.badge.inherited'),
  });

  return (
    <div className="grid min-h-[58px] grid-cols-1 gap-2 border-t border-border/50 px-3 py-2 first:border-t-0 @min-[960px]/openagent-group:grid-cols-[minmax(150px,0.95fr)_minmax(120px,0.7fr)_minmax(0,1.4fr)_64px_90px_72px] @min-[960px]/openagent-group:items-center">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate typography-ui-label font-medium text-foreground">{item.label}</span>
          {projectOverride ? (
            <Badge className="bg-[var(--status-warning)]/10 text-[var(--status-warning)]">{t('settings.openagent.badge.projectOverride')}</Badge>
          ) : null}
        </div>
        <div className="truncate typography-micro text-muted-foreground">{item.description}</div>
      </div>

      <div className="min-w-0">
        <div className="typography-micro text-muted-foreground @min-[960px]/openagent-group:hidden">{t('settings.openagent.table.defaultModel')}</div>
        <div className="truncate font-mono typography-meta text-muted-foreground">{formatDefaultModel(item, t('settings.openagent.model.pluginDefault'))}</div>
      </div>

      <div className="min-w-0">
        <div className="typography-micro text-muted-foreground @min-[960px]/openagent-group:hidden">{t('settings.openagent.table.overrideModel')}</div>
        <CompactModelEditor
          model={model}
          onChange={(nextModel) => updateDraftItem(kind, item.id, { model: nextModel })}
        />
      </div>

      <div className="flex items-center gap-2">
        <span className="typography-micro text-muted-foreground @min-[960px]/openagent-group:hidden">fallback</span>
        <span className="typography-ui-label text-foreground">{fallbackCount}</span>
      </div>

      <div>
        <Badge className={status.className}>{status.label}</Badge>
      </div>

      <div className="flex items-center gap-1.5 @min-[960px]/openagent-group:justify-end">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={() => onEdit({ kind, id: item.id })}
          aria-label={t('settings.openagent.actions.editItemAria', { label: item.label })}
          title={t('settings.openagent.actions.editAdvanced')}
        >
          <RiEditLine className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={() => resetItem(kind, item.id)}
          disabled={!normalizedEntry}
          aria-label={t('settings.openagent.actions.resetItemAria', { label: item.label })}
          title={t('settings.openagent.actions.resetToInherited')}
        >
          <RiRestartLine className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function OpenAgentGroupSection({
  title,
  kind,
  items,
  draft,
  projectOverrides,
  onEdit,
  onAdd,
}: {
  title: string;
  kind: OpenAgentKind;
  items: OpenAgentDisplayItem[];
  draft: OpenAgentDraft;
  projectOverrides: Set<string>;
  onEdit: (target: EditingTarget) => void;
  onAdd?: (kind: OpenAgentKind, id: string) => void;
}) {
  const { t } = useI18n();
  if (items.length === 0 && !onAdd) return null;

  return (
    <section className="@container/openagent-group overflow-hidden rounded-lg border border-border/70 bg-background">
      <div className="flex flex-col gap-2 border-b border-border/70 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="typography-ui-label font-semibold text-foreground">{title}</h3>
          <p className="typography-micro text-muted-foreground">{t('settings.openagent.group.emptyModelHint')}</p>
        </div>
        {onAdd ? <AddCustomControl kind={kind} onAdd={onAdd} /> : null}
      </div>
      <div className="hidden grid-cols-[minmax(150px,0.95fr)_minmax(120px,0.7fr)_minmax(0,1.4fr)_64px_90px_72px] gap-2 border-b border-border/50 px-3 py-1.5 typography-micro font-medium text-muted-foreground @min-[960px]/openagent-group:grid">
        <div>{t('settings.openagent.table.name')}</div>
        <div>{t('settings.openagent.table.defaultModel')}</div>
        <div>{t('settings.openagent.table.overrideModel')}</div>
        <div>fallback</div>
        <div>{t('settings.openagent.table.status')}</div>
        <div className="text-right">{t('settings.openagent.table.actions')}</div>
      </div>
      {items.map((item) => (
        <OpenAgentRow
          key={`${kind}-${item.id}`}
          kind={kind}
          item={item}
          draft={draft}
          projectOverride={projectOverrides.has(item.id)}
          onEdit={onEdit}
        />
      ))}
      {items.length === 0 ? (
        <div className="border-t border-border/50 px-3 py-5 text-center typography-meta text-muted-foreground">
          {t('settings.openagent.empty.noCustomItems')}
        </div>
      ) : null}
    </section>
  );
}

function FallbackEditor({
  rows,
  onChange,
}: {
  rows: OpenAgentFallbackRow[];
  onChange: (rows: OpenAgentFallbackRow[]) => void;
}) {
  const { t } = useI18n();
  const updateRow = (id: string, patch: Partial<OpenAgentFallbackRow>) => {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const moveRow = (index: number, delta: number) => {
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= rows.length) return;
    const next = rows.slice();
    const [row] = next.splice(index, 1);
    next.splice(nextIndex, 0, row);
    onChange(next);
  };

  const addRow = () => {
    onChange([
      ...rows,
      {
        id: `fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        model: '',
        variant: '',
        maxTokens: '',
        reasoningEffort: '',
        originalType: 'string',
      },
    ]);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="typography-ui-label text-foreground">fallback_models</div>
          <div className="typography-micro text-muted-foreground">{t('settings.openagent.fallback.description')}</div>
        </div>
        <Button type="button" size="xs" variant="outline" onClick={addRow}>
          <RiAddLine className="h-3.5 w-3.5" />
          {t('settings.openagent.actions.add')}
        </Button>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/70 px-3 py-4 text-center typography-meta text-muted-foreground">
          {t('settings.openagent.fallback.empty')}
        </div>
      ) : null}

      {rows.map((row, index) => {
        const parsed = parseModelRef(row.model);
        return (
          <div key={row.id} className="rounded-md border border-border/70 p-2">
            <div className="grid gap-2 xl:grid-cols-[minmax(180px,1fr)_96px_82px_82px_108px_76px] xl:items-center">
              <div className="min-w-0 space-y-1.5">
                <ModelSelector
                  providerId={parsed.providerId}
                  modelId={parsed.modelId}
                  onChange={(providerId, modelId) => updateRow(row.id, {
                    model: joinModelRef(providerId, modelId),
                    originalType: row.originalType,
                  })}
                  placeholder={t('settings.openagent.fallback.selectPlaceholder')}
                  className="h-7 max-w-full"
                />
                <Input
                  value={row.model}
                  onChange={(event) => updateRow(row.id, { model: event.target.value })}
                  placeholder="provider/model"
                  className="h-7 font-mono typography-meta"
                />
              </div>
              <Input
                value={row.variant}
                onChange={(event) => updateRow(row.id, { variant: event.target.value, originalType: 'object' })}
                placeholder="variant"
                className="h-7 typography-meta"
              />
              <Input
                value={row.maxTokens}
                onChange={(event) => updateRow(row.id, { maxTokens: event.target.value, originalType: 'object' })}
                placeholder="maxTokens"
                className="h-7 typography-meta"
              />
              <Input
                value={row.temperature ?? ''}
                onChange={(event) => updateRow(row.id, { temperature: event.target.value, originalType: 'object' })}
                placeholder="temp"
                className="h-7 typography-meta"
              />
              <Select
                value={row.reasoningEffort || INHERIT_VALUE}
                onValueChange={(value) => updateRow(row.id, {
                  reasoningEffort: value === INHERIT_VALUE ? '' : value,
                  originalType: 'object',
                })}
              >
                <SelectTrigger className="h-7 w-full" size="sm">
                  <SelectValue>{(value) => value === INHERIT_VALUE ? t('settings.openagent.fallback.reasoningPlaceholder') : value}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT_VALUE}>{t('settings.openagent.model.inherit')}</SelectItem>
                  {REASONING_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>{option}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center justify-end gap-1">
                <Button type="button" size="icon" variant="ghost" onClick={() => moveRow(index, -1)} disabled={index === 0}>
                  <RiArrowUpSLine className="h-4 w-4" />
                </Button>
                <Button type="button" size="icon" variant="ghost" onClick={() => moveRow(index, 1)} disabled={index === rows.length - 1}>
                  <RiArrowDownSLine className="h-4 w-4" />
                </Button>
                <Button type="button" size="icon" variant="ghost" onClick={() => onChange(rows.filter((candidate) => candidate.id !== row.id))}>
                  <RiDeleteBinLine className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              <Input
                value={row.top_p ?? ''}
                onChange={(event) => updateRow(row.id, { top_p: event.target.value, originalType: 'object' })}
                placeholder="top_p"
                className="h-7 typography-meta"
              />
              <Select
                value={row.thinkingType || INHERIT_VALUE}
                onValueChange={(value) => updateRow(row.id, {
                  thinkingType: value === INHERIT_VALUE ? '' : value,
                  originalType: 'object',
                })}
              >
                <SelectTrigger className="h-7 w-full" size="sm">
                  <SelectValue>{(value) => value === INHERIT_VALUE ? t('settings.openagent.fallback.thinkingPlaceholder') : value}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT_VALUE}>{t('settings.openagent.model.inherit')}</SelectItem>
                  {THINKING_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>{option}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={row.thinkingBudgetTokens ?? ''}
                onChange={(event) => updateRow(row.id, { thinkingBudgetTokens: event.target.value, originalType: 'object' })}
                placeholder="thinking budget"
                className="h-7 typography-meta"
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AdvancedDialog({
  target,
  onClose,
}: {
  target: EditingTarget | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const draft = useOpenAgentConfigStore((state) => state.draft);
  const updateDraftItem = useOpenAgentConfigStore((state) => state.updateDraftItem);
  const resetItem = useOpenAgentConfigStore((state) => state.resetItem);
  const [fallbackRows, setFallbackRows] = React.useState<OpenAgentFallbackRow[]>([]);

  const entry = target ? getEntry(draft, target.kind, target.id) : {};
  const kind = target?.kind ?? 'agent';
  const id = target?.id ?? '';
  const label = target ? (target.kind === 'agent' ? t('settings.openagent.dialog.agent') : t('settings.openagent.dialog.category')) : '';

  React.useEffect(() => {
    if (!target) {
      setFallbackRows([]);
      return;
    }
    const nextEntry = getEntry(draft, target.kind, target.id);
    setFallbackRows(fallbackModelsToRows(nextEntry.fallback_models));
    // Intentionally keyed to target only; row edits keep local incomplete rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.kind, target?.id]);

  const update = React.useCallback((patch: Record<string, unknown>) => {
    if (!target) return;
    updateDraftItem(target.kind, target.id, patch);
  }, [target, updateDraftItem]);

  const commitFallbackRows = (rows: OpenAgentFallbackRow[]) => {
    setFallbackRows(rows);
    update({ fallback_models: fallbackRowsToConfig(rows) });
  };

  const thinking: Record<string, unknown> = isRecord(entry.thinking) ? entry.thinking : {};
  const updateThinking = (patch: Record<string, unknown>) => {
    const next = { ...thinking, ...patch };
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined || value === '') {
        delete next[key];
      }
    }
    update({ thinking: Object.keys(next).length > 0 ? next : undefined });
  };

  return (
    <Dialog open={Boolean(target)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="h-[calc(100dvh-2rem)] max-w-3xl gap-0 overflow-hidden p-0 sm:ml-auto sm:mr-0 sm:rounded-l-xl sm:rounded-r-none">
        <DialogHeader className="border-b border-border/70 px-5 py-4">
          <DialogTitle>{label}: {id}</DialogTitle>
          <DialogDescription>
            {t('settings.openagent.dialog.emptyFieldsDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="space-y-5">
            <section className="grid gap-3 md:grid-cols-2">
              <Field label="model" hint={t('settings.openagent.hint.modelProvider')}>
                <CompactModelEditor
                  model={asString(entry.model)}
                  onChange={(model) => update({ model })}
                />
              </Field>

              <Field label="variant">
                <Input
                  value={asString(entry.variant)}
                  onChange={(event) => update({ variant: event.target.value })}
                  placeholder="high / max / custom"
                  className="h-8"
                />
              </Field>

              {kind === 'agent' ? (
                <Field label="category">
                  <Input
                    value={asString(entry.category)}
                    onChange={(event) => update({ category: event.target.value })}
                    placeholder="deep / quick / visual-engineering"
                    className="h-8"
                  />
                </Field>
              ) : null}

              <Field label="maxTokens" hint={t('settings.openagent.hint.maxTokens')}>
                <Input
                  value={asString(entry.maxTokens)}
                  onChange={(event) => update({ maxTokens: event.target.value })}
                  placeholder={t('settings.openagent.placeholder.maxTokensEmpty')}
                  className="h-8"
                />
              </Field>

              <Field label="temperature">
                <Input
                  value={asString(entry.temperature)}
                  onChange={(event) => update({ temperature: event.target.value })}
                  placeholder="0..2"
                  className="h-8"
                />
              </Field>

              <Field label="top_p">
                <Input
                  value={asString(entry.top_p)}
                  onChange={(event) => update({ top_p: event.target.value })}
                  placeholder="0..1"
                  className="h-8"
                />
              </Field>

              <Field label="reasoningEffort">
                <Select
                  value={asString(entry.reasoningEffort) || INHERIT_VALUE}
                  onValueChange={(value) => update({ reasoningEffort: value === INHERIT_VALUE ? undefined : value })}
                >
                  <SelectTrigger className="h-8 w-full" size="lg">
                    <SelectValue>{(value) => value === INHERIT_VALUE ? t('settings.openagent.model.inherit') : value}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT_VALUE}>{t('settings.openagent.model.inherit')}</SelectItem>
                    {REASONING_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>{option}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="textVerbosity">
                <Select
                  value={asString(entry.textVerbosity) || INHERIT_VALUE}
                  onValueChange={(value) => update({ textVerbosity: value === INHERIT_VALUE ? undefined : value })}
                >
                  <SelectTrigger className="h-8 w-full" size="lg">
                    <SelectValue>{(value) => value === INHERIT_VALUE ? t('settings.openagent.model.inherit') : value}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT_VALUE}>{t('settings.openagent.model.inherit')}</SelectItem>
                    {TEXT_VERBOSITY_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>{option}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="thinking.type">
                <Select
                  value={asString(thinking.type) || INHERIT_VALUE}
                  onValueChange={(value) => updateThinking({ type: value === INHERIT_VALUE ? undefined : value })}
                >
                  <SelectTrigger className="h-8 w-full" size="lg">
                    <SelectValue>{(value) => value === INHERIT_VALUE ? t('settings.openagent.model.inherit') : value}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT_VALUE}>{t('settings.openagent.model.inherit')}</SelectItem>
                    {THINKING_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>{option}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="thinking.budgetTokens">
                <Input
                  value={asString(thinking.budgetTokens)}
                  onChange={(event) => updateThinking({ budgetTokens: event.target.value })}
                  placeholder="positive integer"
                  className="h-8"
                />
              </Field>

              {kind === 'category' ? (
                <>
                  <Field label="max_prompt_tokens">
                    <Input
                      value={asString(entry.max_prompt_tokens)}
                      onChange={(event) => update({ max_prompt_tokens: event.target.value })}
                      placeholder="positive integer"
                      className="h-8"
                    />
                  </Field>
                  <label className="flex items-center gap-2 self-end pb-2 typography-ui-label text-foreground">
                    <Checkbox
                      checked={entry.is_unstable_agent === true}
                      onChange={(checked) => update({ is_unstable_agent: checked ? true : undefined })}
                      ariaLabel="is unstable agent"
                    />
                    is_unstable_agent
                  </label>
                </>
              ) : null}

              <label className="flex items-center gap-2 self-end pb-2 typography-ui-label text-foreground">
                <Checkbox
                  checked={entry.disable === true}
                  onChange={(checked) => update({ disable: checked ? true : undefined })}
                  ariaLabel="disable"
                />
                disable
              </label>
            </section>

            <FallbackEditor rows={fallbackRows} onChange={commitFallbackRows} />

            <section className="grid gap-3">
              <Field label="prompt_append">
                <Textarea
                  value={asString(entry.prompt_append)}
                  onChange={(event) => update({ prompt_append: event.target.value })}
                  rows={4}
                  outerClassName="min-h-[112px]"
                  className="font-mono typography-meta"
                  placeholder={t('settings.openagent.placeholder.promptAppend')}
                />
              </Field>

              <JsonTextareaField
                validationId={`${kind}:${id}:tools`}
                label="tools"
                value={entry.tools}
                onChange={(value) => update({ tools: value })}
                placeholder={t('settings.openagent.placeholder.toolsJson')}
              />

              {kind === 'agent' ? (
                <JsonTextareaField
                  validationId={`${kind}:${id}:providerOptions`}
                  label="providerOptions"
                  value={entry.providerOptions}
                  onChange={(value) => update({ providerOptions: value })}
                  placeholder={t('settings.openagent.placeholder.providerOptions')}
                />
              ) : null}
            </section>
          </div>
        </div>

        <DialogFooter className="border-t border-border/70 px-5 py-3">
          <Button type="button" variant="outline" onClick={() => target && resetItem(target.kind, target.id)}>
            <RiRestartLine className="h-3.5 w-3.5" />
            {t('settings.openagent.actions.resetItem')}
          </Button>
          <Button type="button" onClick={onClose}>{t('settings.openagent.actions.done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function JsonPreviewDialog({
  open,
  onOpenChange,
  draft,
  expectedMtimeMs,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: OpenAgentDraft;
  expectedMtimeMs: number | null;
}) {
  const { t } = useI18n();
  const preview = React.useMemo(() => {
    const payload = buildOpenAgentSavePayload(expectedMtimeMs, draft);
    return JSON.stringify({
      disabled_hooks: payload.disabled_hooks,
      ...Object.fromEntries(OPEN_AGENT_TOP_LEVEL_ARRAY_KEYS
        .filter((key) => payload[key] !== undefined)
        .map((key) => [key, payload[key]])),
      default_mode: payload.default_mode,
      hashline_edit: payload.hashline_edit,
      model_fallback: payload.model_fallback,
      runtime_fallback: payload.runtime_fallback,
      ...Object.fromEntries(OPEN_AGENT_TOP_LEVEL_OBJECT_KEYS
        .filter((key) => payload[key] !== undefined)
        .map((key) => [key, payload[key]])),
      agents: payload.agents,
      categories: payload.categories,
    }, null, 2);
  }, [draft, expectedMtimeMs]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('settings.openagent.jsonPreview.title')}</DialogTitle>
          <DialogDescription>{t('settings.openagent.jsonPreview.description')}</DialogDescription>
        </DialogHeader>
        <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border/70 bg-[var(--surface-elevated)] p-3 font-mono typography-meta text-foreground">
          {preview}
        </pre>
      </DialogContent>
    </Dialog>
  );
}

function ContinuationHooksSection() {
  const { t } = useI18n();
  const draft = useOpenAgentConfigStore((state) => state.draft);
  const setDisabledHooks = useOpenAgentConfigStore((state) => state.setDisabledHooks);
  const disabledHooks = React.useMemo(() => new Set(normalizeHookList(draft.disabled_hooks)), [draft.disabled_hooks]);
  const disabledContinuationHookCount = React.useMemo(
    () => CONTINUATION_HOOKS.filter((hook) => disabledHooks.has(hook.id)).length,
    [disabledHooks]
  );
  const otherDisabledHookCount = Math.max(0, disabledHooks.size - disabledContinuationHookCount);

  const setHookEnabled = (hookId: string, enabled: boolean) => {
    const next = new Set(disabledHooks);
    if (enabled) {
      next.delete(hookId);
    } else {
      next.add(hookId);
    }
    setDisabledHooks(Array.from(next));
  };

  return (
    <section className="rounded-lg border border-border/70 bg-background p-3">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h3 className="typography-ui-label font-semibold text-foreground">{t('settings.openagent.continuation.title')}</h3>
          <p className="max-w-3xl typography-ui text-muted-foreground">
            {t('settings.openagent.continuation.description')}
          </p>
        </div>
        {disabledContinuationHookCount > 0 ? <Badge className="bg-[var(--status-warning)]/10 text-[var(--status-warning)]">{t('settings.openagent.continuation.disabledCount', { count: disabledContinuationHookCount })}</Badge> : null}
      </div>

      {otherDisabledHookCount > 0 ? (
        <p className="mt-2 typography-micro text-muted-foreground">
          {t('settings.openagent.continuation.otherDisabled', { count: otherDisabledHookCount })}
        </p>
      ) : null}

      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {CONTINUATION_HOOKS.map((hook) => {
          const enabled = !disabledHooks.has(hook.id);
          return (
            <div key={hook.id} className="flex min-w-0 items-start justify-between gap-3 rounded-md border border-border/70 bg-[var(--surface-elevated)] px-3 py-2">
              <div className="min-w-0 space-y-0.5">
                <div className="typography-ui-label font-medium text-foreground">{t(hook.labelKey)}</div>
                <div className="font-mono typography-micro text-muted-foreground">{hook.id}</div>
                <div className="typography-micro text-muted-foreground">{t(hook.descriptionKey)}</div>
              </div>
              <Switch checked={enabled} onCheckedChange={(checked) => setHookEnabled(hook.id, Boolean(checked))} aria-label={t('settings.openagent.continuation.enableAria', { label: t(hook.labelKey) })} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function StructuredConfigSection({
  title,
  description,
  children,
  advanced,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  advanced?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border/70 bg-[var(--surface-elevated)] p-3">
      <div className="space-y-1">
        <h4 className="typography-ui-label font-semibold text-foreground">{title}</h4>
        <p className="typography-micro text-muted-foreground">{description}</p>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {children}
      </div>
      {advanced ? <div className="mt-2">{advanced}</div> : null}
    </div>
  );
}

function BackgroundTaskSettings({ value, onChange }: { value: unknown; onChange: (value: Record<string, unknown> | undefined) => void }) {
  const { t } = useI18n();
  const objectValue = getRecordValue(value);
  const update = (key: string, nextValue: unknown) => onChange(setObjectField(objectValue, key, nextValue));
  const updateCircuitBreaker = (key: string, nextValue: unknown) => onChange(setNestedObjectField(objectValue, 'circuitBreaker', key, nextValue));

  return (
    <StructuredConfigSection
      title={t('settings.openagent.global.backgroundTask.label')}
      description={t('settings.openagent.global.backgroundTask.description')}
      advanced={<AdvancedJsonField validationId="global:background_task" label="background_task" value={value} onChange={(nextValue) => onChange(isRecord(nextValue) ? nextValue : undefined)} placeholder='{ "providerConcurrency": { "openai": 2 } }' />}
    >
      <NumberObjectField value={getFieldNumber(objectValue, 'defaultConcurrency')} label="defaultConcurrency" min={1} onChange={(nextValue) => update('defaultConcurrency', nextValue)} />
      <NumberObjectField value={getFieldNumber(objectValue, 'maxDepth')} label="maxDepth" min={1} onChange={(nextValue) => update('maxDepth', nextValue)} />
      <NumberObjectField value={getFieldNumber(objectValue, 'maxToolCalls')} label="maxToolCalls" min={10} onChange={(nextValue) => update('maxToolCalls', nextValue)} />
      <NumberObjectField value={getFieldNumber(objectValue, 'staleTimeoutMs')} label="staleTimeoutMs" min={60000} onChange={(nextValue) => update('staleTimeoutMs', nextValue)} />
      <BooleanObjectField value={getRecordValue(objectValue.circuitBreaker).enabled} label="circuitBreaker.enabled" onChange={(nextValue) => updateCircuitBreaker('enabled', nextValue)} />
      <NumberObjectField value={getNestedFieldNumber(objectValue, 'circuitBreaker', 'consecutiveThreshold')} label="circuitBreaker.consecutiveThreshold" min={5} onChange={(nextValue) => updateCircuitBreaker('consecutiveThreshold', nextValue)} />
    </StructuredConfigSection>
  );
}

function TeamModeSettings({ value, onChange }: { value: unknown; onChange: (value: Record<string, unknown> | undefined) => void }) {
  const { t } = useI18n();
  const objectValue = getRecordValue(value);
  const update = (key: string, nextValue: unknown) => onChange(setObjectField(objectValue, key, nextValue));

  return (
    <StructuredConfigSection
      title={t('settings.openagent.global.teamMode.label')}
      description={t('settings.openagent.global.teamMode.description')}
      advanced={<AdvancedJsonField validationId="global:team_mode" label="team_mode" value={value} onChange={(nextValue) => onChange(isRecord(nextValue) ? nextValue : undefined)} placeholder='{ "enabled": true, "max_parallel_members": 4 }' />}
    >
      <BooleanObjectField value={objectValue.enabled} label="enabled" onChange={(nextValue) => update('enabled', nextValue)} />
      <BooleanObjectField value={objectValue.tmux_visualization} label="tmux_visualization" onChange={(nextValue) => update('tmux_visualization', nextValue)} />
      <NumberObjectField value={getFieldNumber(objectValue, 'max_parallel_members')} label="max_parallel_members" min={1} max={8} onChange={(nextValue) => update('max_parallel_members', nextValue)} />
      <NumberObjectField value={getFieldNumber(objectValue, 'max_members')} label="max_members" min={1} max={8} onChange={(nextValue) => update('max_members', nextValue)} />
      <NumberObjectField value={getFieldNumber(objectValue, 'max_member_turns')} label="max_member_turns" min={1} onChange={(nextValue) => update('max_member_turns', nextValue)} />
      <NumberObjectField value={getFieldNumber(objectValue, 'max_wall_clock_minutes')} label="max_wall_clock_minutes" min={1} onChange={(nextValue) => update('max_wall_clock_minutes', nextValue)} />
      <NumberObjectField value={getFieldNumber(objectValue, 'max_messages_per_run')} label="max_messages_per_run" min={1} onChange={(nextValue) => update('max_messages_per_run', nextValue)} />
      <TextObjectField value={objectValue.base_dir} label="base_dir" placeholder="~/.omo/teams" onChange={(nextValue) => update('base_dir', nextValue)} />
      <NumberObjectField value={getFieldNumber(objectValue, 'mailbox_poll_interval_ms')} label="mailbox_poll_interval_ms" min={500} onChange={(nextValue) => update('mailbox_poll_interval_ms', nextValue)} />
    </StructuredConfigSection>
  );
}

function ModelCapabilitiesSettings({ value, onChange }: { value: unknown; onChange: (value: Record<string, unknown> | undefined) => void }) {
  const { t } = useI18n();
  const objectValue = getRecordValue(value);
  const update = (key: string, nextValue: unknown) => onChange(setObjectField(objectValue, key, nextValue));

  return (
    <StructuredConfigSection
      title={t('settings.openagent.global.modelCapabilities.label')}
      description={t('settings.openagent.global.modelCapabilities.description')}
      advanced={<AdvancedJsonField validationId="global:model_capabilities" label="model_capabilities" value={value} onChange={(nextValue) => onChange(isRecord(nextValue) ? nextValue : undefined)} placeholder='{ "enabled": true, "auto_refresh_on_start": true }' />}
    >
      <BooleanObjectField value={objectValue.enabled} label="enabled" onChange={(nextValue) => update('enabled', nextValue)} />
      <BooleanObjectField value={objectValue.auto_refresh_on_start} label="auto_refresh_on_start" onChange={(nextValue) => update('auto_refresh_on_start', nextValue)} />
      <NumberObjectField value={getFieldNumber(objectValue, 'refresh_timeout_ms')} label="refresh_timeout_ms" min={1} onChange={(nextValue) => update('refresh_timeout_ms', nextValue)} />
      <TextObjectField value={objectValue.source_url} label="source_url" placeholder="https://models.dev/api.json" onChange={(nextValue) => update('source_url', nextValue)} />
    </StructuredConfigSection>
  );
}

function ExperimentalSettings({ value, onChange }: { value: unknown; onChange: (value: Record<string, unknown> | undefined) => void }) {
  const { t } = useI18n();
  const objectValue = getRecordValue(value);
  const update = (key: string, nextValue: unknown) => onChange(setObjectField(objectValue, key, nextValue));

  return (
    <StructuredConfigSection
      title={t('settings.openagent.global.experimental.label')}
      description={t('settings.openagent.global.experimental.description')}
      advanced={<AdvancedJsonField validationId="global:experimental" label="experimental" value={value} onChange={(nextValue) => onChange(isRecord(nextValue) ? nextValue : undefined)} placeholder='{ "dynamic_context_pruning": { "enabled": false } }' />}
    >
      {['aggressive_truncation', 'auto_resume', 'preemptive_compaction', 'truncate_all_tool_outputs', 'task_system', 'safe_hook_creation', 'disable_omo_env', 'hashline_edit', 'model_fallback_title'].map((key) => (
        <BooleanObjectField key={key} value={objectValue[key]} label={key} onChange={(nextValue) => update(key, nextValue)} />
      ))}
      <NumberObjectField value={getFieldNumber(objectValue, 'plugin_load_timeout_ms')} label="plugin_load_timeout_ms" min={1000} onChange={(nextValue) => update('plugin_load_timeout_ms', nextValue)} />
      <NumberObjectField value={getFieldNumber(objectValue, 'max_tools')} label="max_tools" min={1} onChange={(nextValue) => update('max_tools', nextValue)} />
    </StructuredConfigSection>
  );
}

function TmuxSettings({ value, onChange }: { value: unknown; onChange: (value: Record<string, unknown> | undefined) => void }) {
  const { t } = useI18n();
  const objectValue = getRecordValue(value);
  const update = (key: string, nextValue: unknown) => onChange(setObjectField(objectValue, key, nextValue));

  return (
    <StructuredConfigSection
      title={t('settings.openagent.global.tmux.label')}
      description={t('settings.openagent.global.tmux.description')}
      advanced={<AdvancedJsonField validationId="global:tmux" label="tmux" value={value} onChange={(nextValue) => onChange(isRecord(nextValue) ? nextValue : undefined)} placeholder='{ "enabled": false }' />}
    >
      <BooleanObjectField value={objectValue.enabled} label="enabled" onChange={(nextValue) => update('enabled', nextValue)} />
      <Field label="layout">
        <Select value={asString(objectValue.layout) || INHERIT_VALUE} onValueChange={(nextValue) => update('layout', nextValue === INHERIT_VALUE ? undefined : nextValue)}>
          <SelectTrigger className="h-8 w-full" size="sm"><SelectValue>{(currentValue) => currentValue === INHERIT_VALUE ? t('settings.openagent.model.inherit') : currentValue}</SelectValue></SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT_VALUE}>{t('settings.openagent.model.inherit')}</SelectItem>
            {['main-horizontal', 'main-vertical', 'tiled', 'even-horizontal', 'even-vertical'].map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
      <Field label="isolation">
        <Select value={asString(objectValue.isolation) || INHERIT_VALUE} onValueChange={(nextValue) => update('isolation', nextValue === INHERIT_VALUE ? undefined : nextValue)}>
          <SelectTrigger className="h-8 w-full" size="sm"><SelectValue>{(currentValue) => currentValue === INHERIT_VALUE ? t('settings.openagent.model.inherit') : currentValue}</SelectValue></SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT_VALUE}>{t('settings.openagent.model.inherit')}</SelectItem>
            {['inline', 'window', 'session'].map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
      <NumberObjectField value={getFieldNumber(objectValue, 'main_pane_size')} label="main_pane_size" min={20} max={80} onChange={(nextValue) => update('main_pane_size', nextValue)} />
      <NumberObjectField value={getFieldNumber(objectValue, 'main_pane_min_width')} label="main_pane_min_width" min={40} onChange={(nextValue) => update('main_pane_min_width', nextValue)} />
      <NumberObjectField value={getFieldNumber(objectValue, 'agent_pane_min_width')} label="agent_pane_min_width" min={20} onChange={(nextValue) => update('agent_pane_min_width', nextValue)} />
    </StructuredConfigSection>
  );
}

function SkillsSettings({ value, onChange }: { value: unknown; onChange: (value: Record<string, unknown> | undefined) => void }) {
  const { t } = useI18n();
  const objectValue = getRecordValue(value);
  const update = (key: string, nextValue: unknown) => onChange(setObjectField(objectValue, key, nextValue));

  return (
    <StructuredConfigSection
      title={t('settings.openagent.global.skills.label')}
      description={t('settings.openagent.global.skills.description')}
      advanced={<AdvancedJsonField validationId="global:skills" label="skills" value={value} onChange={(nextValue) => onChange(isRecord(nextValue) ? nextValue : undefined)} placeholder='{ "sources": [".agents/skills"], "enable": [], "disable": [] }' />}
    >
      <Field label="sources">
        <Input value={formatStringOnlyList(objectValue.sources)} onChange={(event) => update('sources', parseStringList(event.target.value))} placeholder=".agents/skills, ~/.config/opencode/skills" className="h-8 font-mono typography-meta" />
      </Field>
      <Field label="enable">
        <Input value={formatStringOnlyList(objectValue.enable)} onChange={(event) => update('enable', parseStringList(event.target.value))} placeholder="skill-id, another-skill" className="h-8 font-mono typography-meta" />
      </Field>
      <Field label="disable">
        <Input value={formatStringOnlyList(objectValue.disable)} onChange={(event) => update('disable', parseStringList(event.target.value))} placeholder="skill-id, another-skill" className="h-8 font-mono typography-meta" />
      </Field>
    </StructuredConfigSection>
  );
}

function OpenAgentGlobalSection() {
  const { t } = useI18n();
  const draft = useOpenAgentConfigStore((state) => state.draft);
  const updateDraft = useOpenAgentConfigStore((state) => state.updateDraft);

  return (
    <section className="rounded-lg border border-border/70 bg-background p-3">
      <div className="space-y-1">
        <h3 className="typography-ui-label font-semibold text-foreground">{t('settings.openagent.global.title')}</h3>
        <p className="max-w-3xl typography-ui text-muted-foreground">{t('settings.openagent.global.description')}</p>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Field label={t('settings.openagent.global.defaultMode.label')} hint={t('settings.openagent.global.defaultMode.description')}>
          <Select
            value={asString(draft.default_mode) || INHERIT_VALUE}
            onValueChange={(value) => updateDraft({ default_mode: value === INHERIT_VALUE ? undefined : value })}
          >
            <SelectTrigger className="h-8 w-full" size="sm">
              <SelectValue>{(value) => value === INHERIT_VALUE ? t('settings.openagent.model.inherit') : value}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT_VALUE}>{t('settings.openagent.model.inherit')}</SelectItem>
              {DEFAULT_MODE_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>{option}</SelectItem>
              ))}
              {draft.default_mode && !DEFAULT_MODE_OPTIONS.includes(draft.default_mode) ? (
                <SelectItem value={draft.default_mode}>{draft.default_mode}</SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </Field>

        <Field label={t('settings.openagent.global.hashlineEdit.label')} hint={t('settings.openagent.global.hashlineEdit.description')}>
          <TriStateBooleanSelect value={draft.hashline_edit} onChange={(value) => updateDraft({ hashline_edit: value })} />
        </Field>

        <Field label={t('settings.openagent.global.modelFallback.label')} hint={t('settings.openagent.global.modelFallback.description')}>
          <TriStateBooleanSelect value={draft.model_fallback} onChange={(value) => updateDraft({ model_fallback: value })} />
        </Field>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {GLOBAL_ARRAY_FIELDS.map((field) => (
          <Field key={field.key} label={t(field.labelKey)} hint={t(field.descriptionKey)}>
            <Input
              value={formatStringList(draft[field.key])}
              onChange={(event) => updateDraft({ [field.key]: parseStringList(event.target.value) })}
              placeholder={field.placeholder}
              className="h-8 font-mono typography-meta"
            />
          </Field>
        ))}
      </div>

      <div className="mt-4 space-y-3">
        <RuntimeFallbackField
          value={draft.runtime_fallback}
          onChange={(value) => updateDraft({ runtime_fallback: value })}
        />
        <SkillsSettings value={draft.skills} onChange={(value) => updateDraft({ skills: value })} />
      </div>
    </section>
  );
}

function OpenAgentAdvancedGlobalSection() {
  const draft = useOpenAgentConfigStore((state) => state.draft);
  const updateDraft = useOpenAgentConfigStore((state) => state.updateDraft);

  return (
    <section className="space-y-3">
      <BackgroundTaskSettings value={draft.background_task} onChange={(value) => updateDraft({ background_task: value })} />
      <TeamModeSettings value={draft.team_mode} onChange={(value) => updateDraft({ team_mode: value })} />
      <ModelCapabilitiesSettings value={draft.model_capabilities} onChange={(value) => updateDraft({ model_capabilities: value })} />
      <ExperimentalSettings value={draft.experimental} onChange={(value) => updateDraft({ experimental: value })} />
      <TmuxSettings value={draft.tmux} onChange={(value) => updateDraft({ tmux: value })} />
    </section>
  );
}

function OpenAgentContentWrapper({
  embedded,
  children,
}: {
  embedded?: boolean;
  children: React.ReactNode;
}) {
  if (embedded) {
    return <div className="space-y-4">{children}</div>;
  }
  return <SettingsPageLayout className="max-w-6xl space-y-4">{children}</SettingsPageLayout>;
}

export const OpenAgentPage: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const { t } = useI18n();
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const config = useOpenAgentConfigStore((state) => state.config);
  const draft = useOpenAgentConfigStore((state) => state.draft);
  const initialDraft = useOpenAgentConfigStore((state) => state.initialDraft);
  const isLoading = useOpenAgentConfigStore((state) => state.isLoading);
  const isSaving = useOpenAgentConfigStore((state) => state.isSaving);
  const isPluginSaving = useOpenAgentConfigStore((state) => state.isPluginSaving);
  const error = useOpenAgentConfigStore((state) => state.error);
  const loadConfig = useOpenAgentConfigStore((state) => state.loadConfig);
  const saveChanges = useOpenAgentConfigStore((state) => state.saveChanges);
  const setPluginEnabled = useOpenAgentConfigStore((state) => state.setPluginEnabled);
  const discardChanges = useOpenAgentConfigStore((state) => state.discardChanges);
  const updateDraftItem = useOpenAgentConfigStore((state) => state.updateDraftItem);

  const [editingTarget, setEditingTarget] = React.useState<EditingTarget | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = React.useState(false);
  const [jsonFieldStates, setJsonFieldStates] = React.useState<Record<string, JsonFieldState>>({});
  const [jsonResetVersion, setJsonResetVersion] = React.useState(0);

  const resetJsonFieldStates = React.useCallback(() => {
    setJsonFieldStates({});
    setJsonResetVersion((version) => version + 1);
  }, []);

  const setJsonFieldState = React.useCallback((id: string, fieldState: JsonFieldState | null) => {
    setJsonFieldStates((previous) => {
      if (!fieldState) {
        if (!previous[id]) return previous;
        const next = { ...previous };
        delete next[id];
        return next;
      }
      const previousState = previous[id];
      if (previousState?.text === fieldState.text && previousState.error === fieldState.error) return previous;
      return { ...previous, [id]: fieldState };
    });
  }, []);

  const jsonValidationContext = React.useMemo(() => ({
    jsonFieldStates,
    resetVersion: jsonResetVersion,
    setJsonFieldState,
  }), [jsonFieldStates, jsonResetVersion, setJsonFieldState]);

  React.useEffect(() => {
    void loadConfig({ force: true });
    void useConfigStore.getState().loadProviders();
  }, [activeProjectId, loadConfig]);

  const hasChanges = hasOpenAgentDraftChanges(initialDraft, draft);
  const jsonErrorCount = Object.values(jsonFieldStates).filter((state) => state.error).length;
  const hasJsonErrors = jsonErrorCount > 0;
  const projectAgentOverrides = React.useMemo(() => new Set(config?.project.overriddenAgents ?? []), [config]);
  const projectCategoryOverrides = React.useMemo(() => new Set(config?.project.overriddenCategories ?? []), [config]);

  const agentItems = React.useMemo(() => buildDisplayItems(
    config?.agents,
    'agent',
    draft,
    config?.project.overriddenAgents ?? [],
    t('settings.openagent.group.customUnknown'),
  ), [config, draft, t]);

  const categoryItems = React.useMemo(() => buildDisplayItems(
    config?.categories,
    'category',
    draft,
    config?.project.overriddenCategories ?? [],
    t('settings.openagent.group.customUnknown'),
  ), [config, draft, t]);

  const mainAgents = agentItems.filter((item) => item.group === 'main');
  const subAgents = agentItems.filter((item) => item.group === 'sub');
  const customAgents = agentItems.filter((item) => item.group === 'custom');
  const knownCategories = categoryItems.filter((item) => item.group !== 'custom');
  const customCategories = categoryItems.filter((item) => item.group === 'custom');

  const projectOverrideCount = (config?.project.overriddenAgents.length ?? 0) + (config?.project.overriddenCategories.length ?? 0);
  const pluginEnabled = config?.plugin.enabled ?? config?.plugin.detected ?? false;

  const handleReload = async () => {
    if (hasChanges && typeof window !== 'undefined' && !window.confirm(t('settings.openagent.confirm.reloadDiscard'))) {
      return;
    }
    const ok = await loadConfig({ force: true });
    if (!ok) {
      toast.error(t('settings.openagent.toast.loadFailed'));
      return;
    }
    resetJsonFieldStates();
    toast.success(t('settings.openagent.toast.reloaded'));
  };

  const handleSave = async () => {
    if (hasJsonErrors) {
      toast.error(t('settings.openagent.toast.fixJsonBeforeSaving'));
      return;
    }
    const result = await saveChanges();
    if (!result.ok) {
      if (result.conflict) {
        toast.error(t('settings.openagent.toast.conflict'));
      } else {
        toast.error(result.message || t('settings.openagent.toast.saveFailed'));
      }
      return;
    }
    resetJsonFieldStates();
    toast.success(t('settings.openagent.toast.saved'));
  };

  const handleDiscard = () => {
    discardChanges();
    resetJsonFieldStates();
  };

  const handlePluginToggle = async (enabled: boolean) => {
    if (hasChanges && typeof window !== 'undefined' && !window.confirm(t('settings.openagent.confirm.togglePluginDiscard'))) {
      return;
    }

    const result = await setPluginEnabled(enabled);
    if (!result.ok) {
      if (result.conflict) {
        toast.error(t('settings.openagent.toast.pluginConflict'));
      } else {
        toast.error(result.message || t('settings.openagent.toast.pluginToggleFailed'));
      }
      return;
    }
    toast.success(enabled ? t('settings.openagent.toast.pluginEnabled') : t('settings.openagent.toast.pluginDisabled'));
  };

  const handleAddCustom = (kind: OpenAgentKind, id: string) => {
    const existingRecord = getDraftRecord(draft, kind);
    if (existingRecord[id]) {
      toast.error(t('settings.openagent.toast.idExists'));
      return;
    }
    updateDraftItem(kind, id, { model: '' });
    setEditingTarget({ kind, id });
  };

  return (
    <JsonValidationContext.Provider value={jsonValidationContext}>
    <OpenAgentContentWrapper embedded={embedded}>
      <div className="space-y-1">
        <h2 className="typography-ui-header font-semibold text-foreground">
          {embedded ? 'Oh My OpenAgent / OMO' : t('settings.page.openagent.title')}
        </h2>
        <p className="typography-ui text-muted-foreground">
          {t('settings.openagent.description')}
        </p>
      </div>

      <div className="rounded-lg border border-border/70 bg-[var(--surface-elevated)] px-3 py-2">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge className={config?.plugin.detected ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}>
                {pluginEnabled ? t('settings.openagent.badge.pluginEnabled') : t('settings.openagent.badge.pluginDisabled')}
              </Badge>
              {isPluginSaving ? <Badge className="bg-primary/10 text-primary">{t('settings.openagent.badge.switchingPlugin')}</Badge> : null}
              {config?.target.isLegacy ? (
                <Badge className="bg-[var(--status-warning)]/10 text-[var(--status-warning)]">{t('settings.openagent.badge.legacyConfig')}</Badge>
              ) : null}
              {projectOverrideCount > 0 ? (
                <Badge className="bg-[var(--status-warning)]/10 text-[var(--status-warning)]">
                  {t('settings.openagent.badge.projectOverrideCount', { count: projectOverrideCount })}
                </Badge>
              ) : null}
              {hasChanges ? (
                <Badge className="bg-primary/10 text-primary">{t('settings.openagent.badge.unsavedChanges')}</Badge>
              ) : null}
              {hasJsonErrors ? (
                <Badge className="bg-[var(--status-error)]/10 text-[var(--status-error)]">
                  {t('settings.openagent.badge.invalidJsonCount', { count: jsonErrorCount })}
                </Badge>
              ) : null}
            </div>
            <div className="break-all font-mono typography-micro text-muted-foreground">
              {config?.target.path ?? t('settings.openagent.state.readingConfigPath')}
            </div>
            <div className="break-all font-mono typography-micro text-muted-foreground">
              {t('settings.openagent.plugin.registrationPrefix')}: {config?.plugin.configPath ?? config?.plugin.writeTargetPath ?? t('settings.openagent.state.readingOpenCodeConfig')}
            </div>
            {config?.project.exists ? (
              <div className="break-all typography-micro text-[var(--status-warning)]">
                {t('settings.openagent.project.overrideAt', { path: config.project.path })}
              </div>
            ) : null}
            {error ? <div className="typography-micro text-[var(--status-error)]">{error}</div> : null}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {!embedded ? (
              <div className="mr-1 flex items-center gap-2 rounded-md border border-border/70 px-2 py-1">
                <RiPlugLine className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="typography-micro text-foreground">{t('settings.openagent.plugin.masterSwitch')}</span>
                <Switch
                  checked={pluginEnabled}
                  onCheckedChange={(checked) => void handlePluginToggle(Boolean(checked))}
                  disabled={isLoading || isSaving || isPluginSaving}
                  aria-label={t('settings.openagent.plugin.toggleAria')}
                />
              </div>
            ) : null}
            <Button type="button" size="xs" variant="outline" onClick={handleReload} disabled={isLoading || isSaving}>
              <RiRefreshLine className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
              {t('settings.openagent.actions.reload')}
            </Button>
            <Button type="button" size="xs" variant="outline" onClick={() => setIsPreviewOpen(true)}>
              <RiCodeLine className="h-3.5 w-3.5" />
              {t('settings.openagent.actions.jsonPreview')}
            </Button>
            <Button type="button" size="xs" variant="outline" onClick={handleDiscard} disabled={!hasChanges || isSaving}>
              {t('settings.openagent.actions.discardChanges')}
            </Button>
            <Button type="button" size="xs" onClick={handleSave} disabled={!hasChanges || hasJsonErrors || isSaving || isPluginSaving}>
              {isSaving ? <RiRefreshLine className="h-3.5 w-3.5 animate-spin" /> : <RiSaveLine className="h-3.5 w-3.5" />}
              {isSaving ? t('settings.openagent.actions.saving') : t('settings.openagent.actions.saveChanges')}
            </Button>
          </div>
        </div>
      </div>

      <ContinuationHooksSection />
      <OpenAgentGlobalSection />

      <OpenAgentGroupSection
        title={t('settings.openagent.group.mainAgents')}
        kind="agent"
        items={mainAgents}
        draft={draft}
        projectOverrides={projectAgentOverrides}
        onEdit={setEditingTarget}
      />

      <OpenAgentGroupSection
        title={t('settings.openagent.group.subAgents')}
        kind="agent"
        items={subAgents}
        draft={draft}
        projectOverrides={projectAgentOverrides}
        onEdit={setEditingTarget}
      />

      <OpenAgentGroupSection
        title={t('settings.openagent.group.categories')}
        kind="category"
        items={knownCategories}
        draft={draft}
        projectOverrides={projectCategoryOverrides}
        onEdit={setEditingTarget}
      />

      <OpenAgentGroupSection
        title={t('settings.openagent.group.customUnknown')}
        kind="agent"
        items={customAgents}
        draft={draft}
        projectOverrides={projectAgentOverrides}
        onEdit={setEditingTarget}
        onAdd={handleAddCustom}
      />

      <OpenAgentGroupSection
        title={t('settings.openagent.group.customCategories')}
        kind="category"
        items={customCategories}
        draft={draft}
        projectOverrides={projectCategoryOverrides}
        onEdit={setEditingTarget}
        onAdd={handleAddCustom}
      />

      <OpenAgentAdvancedGlobalSection />

      {!isLoading && agentItems.length === 0 && categoryItems.length === 0 ? (
        <div className="rounded-lg border border-border/70 px-4 py-10 text-center typography-ui text-muted-foreground">
          {t('settings.openagent.empty.noConfigItems')}
        </div>
      ) : null}

      <AdvancedDialog target={editingTarget} onClose={() => setEditingTarget(null)} />
      <JsonPreviewDialog
        open={isPreviewOpen}
        onOpenChange={setIsPreviewOpen}
        draft={draft}
        expectedMtimeMs={config?.target.mtimeMs ?? null}
      />
    </OpenAgentContentWrapper>
    </JsonValidationContext.Provider>
  );
};
