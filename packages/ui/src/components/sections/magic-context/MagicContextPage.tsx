import React from 'react';
import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowUpSLine,
  RiCodeLine,
  RiDeleteBinLine,
  RiEditLine,
  RiRefreshLine,
  RiRestartLine,
  RiSaveLine,
} from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { useConfigStore } from '@/stores/useConfigStore';
import { useMagicContextConfigStore, type MagicContextConfigResponse } from '@/stores/useMagicContextConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  agentFallbackModelsToRows,
  agentFallbackRowsToConfig,
  buildMagicContextSavePayload,
  CANONICAL_DREAMER_TASKS,
  countFallbackModels,
  DEFAULT_DREAMER_TASK_SCHEDULES,
  hasMagicContextDraftChanges,
  joinModelRef,
  normalizeMagicContextConfig,
  parseModelRef,
  type MagicContextAgentConfig,
  type MagicContextConfig,
  type MagicContextDreamTaskConfig,
  type MagicContextFallbackRow,
} from './magicContextConfig';

const INHERIT_VALUE = '__inherit__';
type MagicAgentId = 'historian' | 'dreamer' | 'sidekick';

type MapValueType = 'string' | 'number';
type MapRow = {
  id: string;
  key: string;
  value: string;
};

const AGENT_DEFINITIONS: Array<{
  id: MagicAgentId;
  label: string;
  descriptionKey: I18nKey;
  defaultChain: string;
}> = [
  {
    id: 'historian',
    label: 'Historian',
    descriptionKey: 'settings.magicContext.agent.historian.description',
    defaultChain: 'github-copilot/claude-sonnet-4-6 -> anthropic/claude-sonnet-4-6 -> openai/gpt-5.4',
  },
  {
    id: 'dreamer',
    label: 'Dreamer',
    descriptionKey: 'settings.magicContext.agent.dreamer.description',
    defaultChain: 'github-copilot/claude-sonnet-4-6 -> google/gemini-3-flash -> openai/gpt-5.4-mini',
  },
  {
    id: 'sidekick',
    label: 'Sidekick',
    descriptionKey: 'settings.magicContext.agent.sidekick.description',
    defaultChain: 'cerebras/qwen-3-235b-a22b-instruct-2507 -> opencode/gpt-5-nano -> google/gemini-3-flash',
  },
];

const AGENT_MODES = ['subagent', 'primary', 'all'];
const EMBEDDING_PROVIDERS = ['local', 'openai-compatible', 'off'];
const HISTORIAN_DISALLOWED_TOOLS = ['*', 'read', 'aft_outline', 'aft_zoom', 'aft_search'];
const VARIANT_OPTIONS: Array<{ value: string; labelKey: I18nKey }> = [
  { value: 'low', labelKey: 'settings.magicContext.variant.low' },
  { value: 'medium', labelKey: 'settings.magicContext.variant.medium' },
  { value: 'high', labelKey: 'settings.magicContext.variant.high' },
  { value: 'xhigh', labelKey: 'settings.magicContext.variant.xhigh' },
  { value: 'max', labelKey: 'settings.magicContext.variant.max' },
];

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const asString = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : String(value);
};

const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const getAgentEntry = (draft: MagicContextConfig, id: MagicAgentId): MagicContextAgentConfig => (
  asRecord(draft[id]) as MagicContextAgentConfig
);

const getDreamerTasks = (entry: MagicContextAgentConfig): Record<string, MagicContextDreamTaskConfig> => (
  asRecord(entry.tasks) as Record<string, MagicContextDreamTaskConfig>
);

const getDreamerTask = (entry: MagicContextAgentConfig, task: string): MagicContextDreamTaskConfig => (
  asRecord(getDreamerTasks(entry)[task]) as MagicContextDreamTaskConfig
);

const buildDreamerTaskPatch = (
  entry: MagicContextAgentConfig,
  task: string,
  patch: Record<string, unknown>,
): Record<string, MagicContextDreamTaskConfig> => {
  const tasks = getDreamerTasks(entry);
  const current = asRecord(tasks[task]);
  const nextTask = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete nextTask[key];
    } else {
      nextTask[key] = value;
    }
  }
  return {
    ...tasks,
    [task]: nextTask as MagicContextDreamTaskConfig,
  };
};

const getDreamerEnabledCount = (entry: MagicContextAgentConfig): number => (
  Object.values(getDreamerTasks(entry)).filter((task) => typeof task?.schedule === 'string' && task.schedule.trim()).length
);

const toggleDreamerTaskEnabled = (
  entry: MagicContextAgentConfig,
  task: string,
  enabled: boolean,
): Record<string, MagicContextDreamTaskConfig> => buildDreamerTaskPatch(entry, task, {
  schedule: enabled ? (asString(getDreamerTask(entry, task).schedule) || DEFAULT_DREAMER_TASK_SCHEDULES[task as keyof typeof DEFAULT_DREAMER_TASK_SCHEDULES] || '0 2 * * *') : '',
});

const parseMaybeNumber = (value: string): string | number => {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : trimmed;
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

function BooleanOverrideSelect({
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
      onValueChange={(nextValue) => {
        if (nextValue === INHERIT_VALUE) {
          onChange(undefined);
        } else {
          onChange(nextValue === 'true');
        }
      }}
    >
      <SelectTrigger className="h-8 w-full" size="lg">
        <SelectValue>
          {(currentValue) => {
            if (currentValue === 'true') return 'true';
            if (currentValue === 'false') return 'false';
            return t('settings.magicContext.common.inherit');
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={INHERIT_VALUE}>{t('settings.magicContext.common.inherit')}</SelectItem>
        <SelectItem value="true">true</SelectItem>
        <SelectItem value="false">false</SelectItem>
      </SelectContent>
    </Select>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border/70 bg-background">
      <div className="border-b border-border/70 px-3 py-2">
        <h3 className="typography-ui-label font-semibold text-foreground">{title}</h3>
        {description ? <p className="typography-micro text-muted-foreground">{description}</p> : null}
      </div>
      <div>{children}</div>
    </section>
  );
}

function DiagnosticItem({
  label,
  ok,
  children,
}: {
  label: string;
  ok: boolean;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="min-w-0 rounded-md border border-border/60 bg-background px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <Badge className={ok ? 'bg-primary/10 text-primary' : 'bg-[var(--status-warning)]/10 text-[var(--status-warning)]'}>
          {ok ? t('settings.magicContext.diagnostics.status.ok') : t('settings.magicContext.diagnostics.status.warning')}
        </Badge>
        <span className="typography-ui-label font-medium text-foreground">{label}</span>
      </div>
      <div className="mt-1 break-all typography-micro text-muted-foreground">{children}</div>
    </div>
  );
}

function DiagnosticsPanel({
  config,
  ignoredProjectKeys,
}: {
  config: MagicContextConfigResponse | null;
  ignoredProjectKeys: string[];
}) {
  const { t } = useI18n();
  const diagnostics = config?.diagnostics;
  const activeHooks = diagnostics?.omo?.activeConflictingHooks ?? [];
  const disabledHooks = diagnostics?.omo?.disabledConflictingHooks ?? [];
  const source = config?.source ?? diagnostics?.source ?? null;
  const target = config?.target ?? null;
  const sourceDiffersFromTarget = Boolean(source?.path && target?.path && source.path !== target.path);
  const pluginOk = config?.plugin.detected === true;
  const tuiOk = diagnostics?.tui?.detected === true;
  const configPathOk = diagnostics?.configPath?.matchesRuntime !== false;
  const omoOk = activeHooks.length === 0;

  return (
    <div className="grid gap-2 pt-1 md:grid-cols-2 xl:grid-cols-4">
      <DiagnosticItem label={t('settings.magicContext.diagnostics.pluginRegistration')} ok={pluginOk}>
        {pluginOk
          ? `${config?.plugin.entry ?? t('settings.magicContext.diagnostics.registered')} @ ${config?.plugin.configPath ?? t('settings.magicContext.diagnostics.unknownPath')}`
          : t('settings.magicContext.diagnostics.pluginMissingDescription')}
      </DiagnosticItem>
      <DiagnosticItem label={t('settings.magicContext.diagnostics.tuiSidebar')} ok={tuiOk}>
        {tuiOk ? `${diagnostics?.tui?.entry ?? t('settings.magicContext.diagnostics.registered')} @ ${diagnostics?.tui?.configPath ?? t('settings.magicContext.diagnostics.unknownPath')}` : t('settings.magicContext.diagnostics.tuiMissingDescription')}
      </DiagnosticItem>
      <DiagnosticItem label={t('settings.magicContext.diagnostics.omoHooks')} ok={omoOk}>
        {activeHooks.length > 0
          ? t('settings.magicContext.diagnostics.omoActiveConflicts', { hooks: activeHooks.join(', ') })
          : disabledHooks.length > 0
            ? t('settings.magicContext.diagnostics.omoDisabledConflicts', { hooks: disabledHooks.join(', ') })
            : t('settings.magicContext.diagnostics.omoNoConflicts')}
      </DiagnosticItem>
      <DiagnosticItem label={t('settings.magicContext.diagnostics.configPath')} ok={configPathOk}>
        {configPathOk
          ? diagnostics?.configPath?.uiConfigDir ?? config?.target.path ?? t('settings.magicContext.diagnostics.pathMatches')
          : t('settings.magicContext.diagnostics.pathMismatch', { uiPath: diagnostics?.configPath?.uiConfigDir ?? '', runtimePath: diagnostics?.configPath?.runtimeConfigDir ?? '' })}
      </DiagnosticItem>
      <DiagnosticItem label="Magic Context source" ok={!sourceDiffersFromTarget && source?.legacy !== true}>
        {source?.path
          ? `read ${source.legacy ? 'legacy ' : ''}${source.path}; write ${target?.path ?? source.path}`
          : target?.path ?? t('settings.magicContext.diagnostics.unknownPath')}
      </DiagnosticItem>
      {ignoredProjectKeys.length > 0 ? (
        <div className="rounded-md border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/10 px-2.5 py-2 md:col-span-2 xl:col-span-4">
          <div className="typography-ui-label font-medium text-[var(--status-warning)]">{t('settings.magicContext.diagnostics.ignoredProjectFieldsTitle')}</div>
          <div className="mt-1 typography-micro text-[var(--status-warning)]">
            {t('settings.magicContext.diagnostics.ignoredProjectFieldsDescription', { keys: ignoredProjectKeys.join(', ') })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RowShell({
  label,
  description,
  overridden,
  projectOverride,
  children,
}: {
  label: string;
  description: string;
  overridden: boolean;
  projectOverride: boolean;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="grid min-h-[54px] grid-cols-1 gap-2 border-t border-border/50 px-3 py-2 first:border-t-0 lg:grid-cols-[minmax(180px,0.75fr)_minmax(0,1.8fr)] lg:items-center">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate typography-ui-label font-medium text-foreground">{label}</span>
          {overridden ? <Badge className="bg-primary/10 text-primary">{t('settings.magicContext.badge.overridden')}</Badge> : null}
          {projectOverride ? <Badge className="bg-[var(--status-warning)]/10 text-[var(--status-warning)]">{t('settings.magicContext.badge.projectOverride')}</Badge> : null}
        </div>
        <div className="typography-micro text-muted-foreground">{description}</div>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
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
  const resolvedPlaceholder = placeholder ?? t('settings.magicContext.common.inheritDefault');

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <ModelSelector
        providerId={parsed.providerId}
        modelId={parsed.modelId}
        onChange={(providerId, modelId) => onChange(joinModelRef(providerId, modelId))}
        placeholder={resolvedPlaceholder}
        className="h-7 min-w-[120px] max-w-[260px] flex-1"
      />
      <Input
        value={model}
        onChange={(event) => onChange(event.target.value)}
        placeholder="provider/model"
        className="h-7 min-w-[160px] flex-1 font-mono typography-meta"
      />
    </div>
  );
}

function InlineModelEditor({
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

  return (
    <ModelSelector
      providerId={parsed.providerId}
      modelId={parsed.modelId}
      onChange={(providerId, modelId) => onChange(joinModelRef(providerId, modelId))}
      placeholder={placeholder ?? t('settings.magicContext.common.inheritDefault')}
      className="h-9 w-full"
    />
  );
}

function BooleanRow({
  field,
  label,
  description,
  draft,
  projectOverrides,
}: {
  field: keyof MagicContextConfig & string;
  label: string;
  description: string;
  draft: MagicContextConfig;
  projectOverrides: Set<string>;
}) {
  const { t } = useI18n();
  const updateDraft = useMagicContextConfigStore((state) => state.updateDraft);
  const resetKey = useMagicContextConfigStore((state) => state.resetKey);
  const normalized = normalizeMagicContextConfig(draft);
  const value = draft[field];

  return (
    <RowShell
      label={label}
      description={description}
      overridden={Object.prototype.hasOwnProperty.call(normalized, field)}
      projectOverride={projectOverrides.has(field)}
    >
      <div className="flex items-center gap-2">
        <div className="w-40">
          <BooleanOverrideSelect
            value={value}
            onChange={(nextValue) => {
              if (nextValue === undefined) {
                resetKey(field);
              } else {
                updateDraft({ [field]: nextValue });
              }
            }}
          />
        </div>
        <span className="typography-meta text-muted-foreground">
          {typeof value === 'boolean' ? (value ? t('settings.magicContext.common.enabled') : t('settings.magicContext.common.disabled')) : t('settings.magicContext.common.inheritDefault')}
        </span>
        <Button type="button" size="icon" variant="ghost" onClick={() => resetKey(field)} title={t('settings.magicContext.actions.removeOverride')}>
          <RiRestartLine className="h-4 w-4" />
        </Button>
      </div>
    </RowShell>
  );
}

function ScalarRow({
  field,
  label,
  description,
  placeholder,
  draft,
  projectOverrides,
}: {
  field: keyof MagicContextConfig & string;
  label: string;
  description: string;
  placeholder: string;
  draft: MagicContextConfig;
  projectOverrides: Set<string>;
}) {
  const { t } = useI18n();
  const updateDraft = useMagicContextConfigStore((state) => state.updateDraft);
  const resetKey = useMagicContextConfigStore((state) => state.resetKey);
  const normalized = normalizeMagicContextConfig(draft);

  return (
    <RowShell
      label={label}
      description={description}
      overridden={Object.prototype.hasOwnProperty.call(normalized, field)}
      projectOverride={projectOverrides.has(field)}
    >
      <div className="flex max-w-xl items-center gap-2">
        <Input
          value={asString(draft[field])}
          onChange={(event) => updateDraft({ [field]: event.target.value })}
          placeholder={placeholder}
          className="h-8 font-mono typography-meta"
        />
        <Button type="button" size="icon" variant="ghost" onClick={() => resetKey(field)} title={t('settings.magicContext.actions.removeOverride')}>
          <RiRestartLine className="h-4 w-4" />
        </Button>
      </div>
    </RowShell>
  );
}

const mapValueToRows = (value: unknown): MapRow[] => {
  if (typeof value === 'string' || typeof value === 'number') {
    return [{ id: 'row-default', key: 'default', value: String(value) }];
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).map(([key, entryValue], index) => ({
    id: `row-${index}-${key}`,
    key,
    value: asString(entryValue),
  }));
};

const rowsToMapValue = (rows: MapRow[], type: MapValueType, allowScalar: boolean): unknown => {
  const entries = rows
    .map((row) => {
      const key = row.key.trim();
      const value = row.value.trim();
      if (!key || !value) return null;
      return [key, type === 'number' ? parseMaybeNumber(value) : value] as const;
    })
    .filter(Boolean) as Array<readonly [string, string | number]>;

  if (entries.length === 0) return {};
  if (allowScalar && entries.length === 1 && entries[0][0] === 'default') {
    return entries[0][1];
  }
  return Object.fromEntries(entries);
};

function MapEditor({
  field,
  label,
  description,
  draft,
  projectOverrides,
  type,
  allowScalar,
  valuePlaceholder,
}: {
  field: keyof MagicContextConfig & string;
  label: string;
  description: string;
  draft: MagicContextConfig;
  projectOverrides: Set<string>;
  type: MapValueType;
  allowScalar: boolean;
  valuePlaceholder: string;
}) {
  const { t } = useI18n();
  const updateDraft = useMagicContextConfigStore((state) => state.updateDraft);
  const resetKey = useMagicContextConfigStore((state) => state.resetKey);
  const normalized = normalizeMagicContextConfig(draft);
  const fieldValue = draft[field];
  const [rows, setRows] = React.useState<MapRow[]>(() => mapValueToRows(draft[field]));
  const localUpdateRef = React.useRef(false);

  React.useEffect(() => {
    if (localUpdateRef.current) {
      localUpdateRef.current = false;
      return;
    }
    setRows(mapValueToRows(fieldValue));
  }, [fieldValue]);

  const commitRows = (nextRows: MapRow[]) => {
    localUpdateRef.current = true;
    setRows(nextRows);
    updateDraft({ [field]: rowsToMapValue(nextRows, type, allowScalar) });
  };

  const addRow = () => {
    setRows([
      ...rows,
      {
        id: `row-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        key: rows.length === 0 ? 'default' : 'provider/model',
        value: '',
      },
    ]);
  };

  return (
    <RowShell
      label={label}
      description={description}
      overridden={Object.prototype.hasOwnProperty.call(normalized, field)}
      projectOverride={projectOverrides.has(field)}
    >
      <div className="space-y-2">
        {rows.length === 0 ? (
          <div className="rounded-md border border-dashed border-border/70 px-3 py-3 typography-meta text-muted-foreground">
            {t('settings.magicContext.map.empty')}
          </div>
        ) : null}
        {rows.map((row) => (
          <div key={row.id} className="grid gap-2 sm:grid-cols-[minmax(160px,1fr)_minmax(120px,0.7fr)_32px] sm:items-center">
            <Input
              value={row.key}
              onChange={(event) => commitRows(rows.map((candidate) => (
                candidate.id === row.id ? { ...candidate, key: event.target.value } : candidate
              )))}
              placeholder={t('settings.magicContext.map.keyPlaceholder')}
              className="h-7 font-mono typography-meta"
            />
            <Input
              value={row.value}
              onChange={(event) => commitRows(rows.map((candidate) => (
                candidate.id === row.id ? { ...candidate, value: event.target.value } : candidate
              )))}
              placeholder={valuePlaceholder}
              className="h-7 font-mono typography-meta"
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => commitRows(rows.filter((candidate) => candidate.id !== row.id))}
              title={t('settings.magicContext.actions.removeRow')}
            >
              <RiDeleteBinLine className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <div className="flex items-center gap-1.5">
          <Button type="button" size="xs" variant="outline" onClick={addRow}>
            <RiAddLine className="h-3.5 w-3.5" />
            {t('settings.magicContext.actions.add')}
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={() => resetKey(field)}>
            <RiRestartLine className="h-3.5 w-3.5" />
            {t('settings.magicContext.actions.removeOverride')}
          </Button>
        </div>
      </div>
    </RowShell>
  );
}

function VariantSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string | undefined) => void;
}) {
  const { t } = useI18n();
  return (
    <Select
      value={value || INHERIT_VALUE}
      onValueChange={(nextValue) => onChange(nextValue === INHERIT_VALUE ? undefined : nextValue)}
    >
      <SelectTrigger className="h-9 w-full" size="lg">
        <SelectValue>
          {(currentValue) => {
            if (currentValue === INHERIT_VALUE) return t('settings.magicContext.common.inherit');
            const option = VARIANT_OPTIONS.find((candidate) => candidate.value === currentValue);
            return option ? t(option.labelKey) : currentValue;
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={INHERIT_VALUE}>{t('settings.magicContext.common.inherit')}</SelectItem>
        {VARIANT_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>{t(option.labelKey)}</SelectItem>
        ))}
        {value && !VARIANT_OPTIONS.some((option) => option.value === value) ? (
          <SelectItem value={value}>{value}</SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  );
}

function AgentSettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2 border-t border-border/60 px-4 py-3 first:border-t-0 md:grid-cols-[minmax(180px,0.9fr)_minmax(240px,1fr)] md:items-center">
      <div className="min-w-0">
        <div className="typography-ui-label font-semibold text-foreground">{label}</div>
        <div className="typography-micro text-muted-foreground">{description}</div>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function AgentCard({
  id,
  label,
  descriptionKey,
  defaultChain,
  draft,
  projectOverrides,
  onEdit,
}: {
  id: MagicAgentId;
  label: string;
  descriptionKey: I18nKey;
  defaultChain: string;
  draft: MagicContextConfig;
  projectOverrides: Set<string>;
  onEdit: (id: MagicAgentId) => void;
}) {
  const { t } = useI18n();
  const updateDraft = useMagicContextConfigStore((state) => state.updateDraft);
  const resetKey = useMagicContextConfigStore((state) => state.resetKey);
  const entry = getAgentEntry(draft, id);
  const normalized = normalizeMagicContextConfig(draft);
  const normalizedEntry = normalized[id] as MagicContextAgentConfig | undefined;
  const fallbackCount = countFallbackModels(entry.fallback_models);
  const isCoreAgent = id === 'historian';
  const enabled = entry.disable !== true;
  const dreamerEnabledTasks = id === 'dreamer' ? getDreamerEnabledCount(entry) : 0;

  const updateAgent = (patch: Record<string, unknown>) => {
    const next = { ...entry };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === '') {
        delete next[key];
      } else {
        next[key] = value;
      }
    }
    updateDraft({
      [id]: next,
    });
  };

  const setEnabled = (checked: boolean) => {
    if (isCoreAgent) return;
    updateAgent({
      disable: checked ? undefined : true,
    });
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-background">
      <div className="flex items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="typography-ui-label font-semibold text-foreground">{label}</span>
            {isCoreAgent ? <Badge className="bg-muted text-muted-foreground">{t('settings.magicContext.badge.core')}</Badge> : null}
            {!isCoreAgent && enabled ? <Badge className="bg-primary/10 text-primary">{t('settings.magicContext.common.enabled')}</Badge> : null}
            {!isCoreAgent && !enabled ? <Badge className="bg-muted text-muted-foreground">{t('settings.magicContext.common.disabled')}</Badge> : null}
            {fallbackCount > 0 ? <Badge className="bg-muted text-muted-foreground">{t('settings.magicContext.agent.fallbackCount', { count: fallbackCount })}</Badge> : null}
            {id === 'dreamer' ? <Badge className="bg-muted text-muted-foreground">{dreamerEnabledTasks} tasks</Badge> : null}
          </div>
          <p className="max-w-3xl typography-ui text-foreground/90">{t(descriptionKey)}</p>
          <p className="truncate font-mono typography-micro text-muted-foreground">{t('settings.magicContext.agent.defaultChain', { chain: defaultChain })}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!isCoreAgent ? (
            <Switch
              checked={enabled}
              onCheckedChange={(checked) => setEnabled(Boolean(checked))}
              aria-label={t('settings.magicContext.agent.enableSwitchAria', { label })}
            />
          ) : null}
          <Button type="button" size="icon" variant="ghost" onClick={() => onEdit(id)} title={t('settings.magicContext.actions.editAgent', { label })}>
            <RiEditLine className="h-4 w-4" />
          </Button>
          <Button type="button" size="icon" variant="ghost" onClick={() => resetKey(id)} disabled={!normalizedEntry} title={t('settings.magicContext.actions.removeOverride')}>
            <RiRestartLine className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div>
        <AgentSettingRow label={t('settings.magicContext.agent.model.label')} description={t('settings.magicContext.agent.model.description')}>
          <InlineModelEditor
            model={asString(entry.model)}
            onChange={(model) => updateAgent({ model })}
          />
        </AgentSettingRow>

        {id === 'historian' ? (
          <>
            <AgentSettingRow label={t('settings.magicContext.agent.twoPass.label')} description={t('settings.magicContext.agent.twoPass.description')}>
              <div className="flex items-center justify-end">
                <Switch
                  checked={entry.two_pass === true}
                  onCheckedChange={(checked) => updateAgent({ two_pass: checked ? true : undefined })}
                  aria-label={t('settings.magicContext.agent.twoPass.aria')}
                />
              </div>
            </AgentSettingRow>
            <AgentSettingRow label={t('settings.magicContext.agent.variant.label')} description={t('settings.magicContext.agent.variant.historianDescription')}>
              <VariantSelect value={asString(entry.variant)} onChange={(value) => updateAgent({ variant: value })} />
            </AgentSettingRow>
          </>
        ) : null}

        {id === 'dreamer' ? (
          <>
            <AgentSettingRow label="tasks" description="Configured Dreamer v2 schedules">
              <div className="flex flex-wrap gap-1.5">
                {CANONICAL_DREAMER_TASKS.map((task) => {
                  const taskConfig = getDreamerTask(entry, task);
                  const active = typeof taskConfig.schedule === 'string' && taskConfig.schedule.trim() !== '';
                  return (
                    <Badge key={task} className={active ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}>
                      {task}
                    </Badge>
                  );
                })}
              </div>
            </AgentSettingRow>
            <AgentSettingRow label={t('settings.magicContext.agent.variant.label')} description={t('settings.magicContext.agent.variant.inheritDescription')}>
              <VariantSelect value={asString(entry.variant)} onChange={(value) => updateAgent({ variant: value })} />
            </AgentSettingRow>
          </>
        ) : null}

        {id === 'sidekick' ? (
          <AgentSettingRow label={t('settings.magicContext.agent.variant.label')} description={t('settings.magicContext.agent.variant.inheritDescription')}>
            <VariantSelect value={asString(entry.variant)} onChange={(value) => updateAgent({ variant: value })} />
          </AgentSettingRow>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 px-4 py-2">
        {normalizedEntry ? <Badge className="bg-primary/10 text-primary">{t('settings.magicContext.badge.overridden')}</Badge> : <Badge className="bg-muted text-muted-foreground">{t('settings.magicContext.common.inheritDefault')}</Badge>}
        {projectOverrides.has(id) ? <Badge className="bg-[var(--status-warning)]/10 text-[var(--status-warning)]">{t('settings.magicContext.badge.projectOverride')}</Badge> : null}
      </div>
    </div>
  );
}

function JsonTextareaField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
  placeholder?: string;
}) {
  const { t } = useI18n();
  const [text, setText] = React.useState(() => (
    value === undefined || value === null ? '' : JSON.stringify(value, null, 2)
  ));
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setText(value === undefined || value === null ? '' : JSON.stringify(value, null, 2));
    setError(null);
  }, [value]);

  const commit = () => {
    const trimmed = text.trim();
    if (!trimmed) {
      setError(null);
      onChange(undefined);
      return;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (!isRecord(parsed)) {
        setError(t('settings.magicContext.validation.jsonObjectRequired'));
        return;
      }
      setError(null);
      onChange(parsed);
    } catch {
      setError(t('settings.magicContext.validation.jsonInvalid'));
    }
  };

  return (
    <Field label={label} hint={error ?? placeholder}>
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        rows={4}
        outerClassName={cn('min-h-[112px]', error && 'ring-[var(--status-error)]')}
        className="font-mono typography-meta"
        placeholder="{ }"
      />
    </Field>
  );
}

function FallbackEditor({
  rows,
  onChange,
}: {
  rows: MagicContextFallbackRow[];
  onChange: (rows: MagicContextFallbackRow[]) => void;
}) {
  const { t } = useI18n();
  const updateRow = (id: string, patch: Partial<MagicContextFallbackRow>) => {
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
      },
    ]);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="typography-ui-label text-foreground">fallback_models</div>
          <div className="typography-micro text-muted-foreground">{t('settings.magicContext.fallback.description')}</div>
        </div>
        <Button type="button" size="xs" variant="outline" onClick={addRow}>
          <RiAddLine className="h-3.5 w-3.5" />
          {t('settings.magicContext.actions.add')}
        </Button>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/70 px-3 py-4 text-center typography-meta text-muted-foreground">
          {t('settings.magicContext.fallback.empty')}
        </div>
      ) : null}

      {rows.map((row, index) => {
        const parsed = parseModelRef(row.model);
        return (
          <div key={row.id} className="rounded-md border border-border/70 p-2">
            <div className="grid gap-2 xl:grid-cols-[minmax(240px,1fr)_80px] xl:items-center">
              <div className="min-w-0 space-y-1.5">
                <ModelSelector
                  providerId={parsed.providerId}
                  modelId={parsed.modelId}
                  onChange={(providerId, modelId) => updateRow(row.id, { model: joinModelRef(providerId, modelId) })}
                  placeholder={t('settings.magicContext.fallback.selectPlaceholder')}
                  className="h-7 max-w-full"
                />
                <Input
                  value={row.model}
                  onChange={(event) => updateRow(row.id, { model: event.target.value })}
                  placeholder="provider/model"
                  className="h-7 font-mono typography-meta"
                />
              </div>
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
          </div>
        );
      })}
    </div>
  );
}

function AgentAdvancedDialog({
  agentId,
  onClose,
}: {
  agentId: MagicAgentId | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const draft = useMagicContextConfigStore((state) => state.draft);
  const updateDraft = useMagicContextConfigStore((state) => state.updateDraft);
  const resetKey = useMagicContextConfigStore((state) => state.resetKey);
  const [fallbackRows, setFallbackRows] = React.useState<MagicContextFallbackRow[]>([]);

  const entry = agentId ? getAgentEntry(draft, agentId) : {};
  const definition = AGENT_DEFINITIONS.find((candidate) => candidate.id === agentId);

  React.useEffect(() => {
    if (!agentId) {
      setFallbackRows([]);
      return;
    }
    const nextEntry = getAgentEntry(draft, agentId);
    setFallbackRows(agentFallbackModelsToRows(nextEntry.fallback_models));
    // Keep incomplete fallback row edits local while the dialog stays on the same agent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  const updateAgent = React.useCallback((patch: Record<string, unknown>) => {
    if (!agentId) return;
    const current = getAgentEntry(useMagicContextConfigStore.getState().draft, agentId);
    const next = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete next[key];
      } else {
        next[key] = value;
      }
    }
    updateDraft({ [agentId]: next });
  }, [agentId, updateDraft]);

  const commitFallbackRows = (rows: MagicContextFallbackRow[]) => {
    setFallbackRows(rows);
    updateAgent({ fallback_models: agentFallbackRowsToConfig(rows) });
  };

  return (
    <Dialog open={Boolean(agentId)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="h-[calc(100dvh-2rem)] max-w-3xl gap-0 overflow-hidden p-0 sm:ml-auto sm:mr-0 sm:rounded-l-xl sm:rounded-r-none">
        <DialogHeader className="border-b border-border/70 px-5 py-4">
          <DialogTitle>{definition?.label ?? t('settings.magicContext.agentDialog.agentFallback')}: {agentId}</DialogTitle>
          <DialogDescription>
            {t('settings.magicContext.agentDialog.emptyFieldsDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="space-y-5">
            <section className="grid gap-3 md:grid-cols-2">
              <Field label="model" hint={t('settings.magicContext.agentDialog.modelHint')}>
                <CompactModelEditor
                  model={asString(entry.model)}
                  onChange={(model) => updateAgent({ model })}
                />
              </Field>

              <Field label="variant">
                <Input value={asString(entry.variant)} onChange={(event) => updateAgent({ variant: event.target.value })} placeholder="custom variant" className="h-8" />
              </Field>

              <Field label="thinking_level" hint={t('settings.magicContext.agentDialog.thinkingLevelHint')}>
                <Input value={asString(entry.thinking_level)} onChange={(event) => updateAgent({ thinking_level: event.target.value })} placeholder="off / low / medium / high" className="h-8" />
              </Field>

              <Field label="temperature">
                <Input value={asString(entry.temperature)} onChange={(event) => updateAgent({ temperature: event.target.value })} placeholder="0..2" className="h-8" />
              </Field>

              <Field label="top_p">
                <Input value={asString(entry.top_p)} onChange={(event) => updateAgent({ top_p: event.target.value })} placeholder="0..1" className="h-8" />
              </Field>

              <Field label="maxTokens" hint={t('settings.magicContext.agentDialog.maxTokensHint')}>
                <Input value={asString(entry.maxTokens)} onChange={(event) => updateAgent({ maxTokens: event.target.value })} placeholder={t('settings.magicContext.agentDialog.omitPlaceholder')} className="h-8" />
              </Field>

              <Field label="maxSteps">
                <Input value={asString(entry.maxSteps)} onChange={(event) => updateAgent({ maxSteps: event.target.value })} placeholder="positive integer" className="h-8" />
              </Field>

              <Field label="mode">
                <Select
                  value={asString(entry.mode) || INHERIT_VALUE}
                  onValueChange={(value) => updateAgent({ mode: value === INHERIT_VALUE ? undefined : value })}
                >
                  <SelectTrigger className="h-8 w-full" size="lg">
                    <SelectValue>{(value) => value === INHERIT_VALUE ? t('settings.magicContext.common.inherit') : value}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT_VALUE}>{t('settings.magicContext.common.inherit')}</SelectItem>
                    {AGENT_MODES.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="color">
                <Input value={asString(entry.color)} onChange={(event) => updateAgent({ color: event.target.value })} placeholder="#RRGGBB" className="h-8 font-mono" />
              </Field>

              <label className="flex items-center gap-2 self-end pb-2 typography-ui-label text-foreground">
                <Checkbox checked={entry.disable === true} onChange={(checked) => updateAgent({ disable: checked ? true : undefined })} ariaLabel="disable agent" />
                disable
              </label>

              {agentId === 'historian' ? (
                <>
                  <Field label="two_pass">
                    <BooleanOverrideSelect value={entry.two_pass} onChange={(value) => updateAgent({ two_pass: value })} />
                  </Field>
                  <Field label="disallowed_tools">
                    <Textarea
                      value={stringArrayToText(entry.disallowed_tools)}
                      onChange={(event) => updateAgent({
                        disallowed_tools: textToStringArray(event.target.value)?.filter((tool) => HISTORIAN_DISALLOWED_TOOLS.includes(tool)),
                      })}
                      rows={4}
                      outerClassName="min-h-[112px]"
                      className="font-mono typography-meta"
                      placeholder={HISTORIAN_DISALLOWED_TOOLS.join('\n')}
                    />
                  </Field>
                </>
              ) : null}
            </section>

            <FallbackEditor rows={fallbackRows} onChange={commitFallbackRows} />

            {agentId === 'dreamer' ? (
              <section className="grid gap-3 rounded-lg border border-border/70 p-3">
                <Field label="inject_docs">
                  <BooleanOverrideSelect value={entry.inject_docs} onChange={(value) => updateAgent({ inject_docs: value })} />
                </Field>
                <div className="grid gap-2">
                  <div className="typography-ui-label font-medium text-foreground">tasks</div>
                  {CANONICAL_DREAMER_TASKS.map((task) => {
                    const taskConfig = getDreamerTask(entry, task);
                    const enabled = typeof taskConfig.schedule === 'string' && taskConfig.schedule.trim() !== '';
                    const fallbackRowsForTask = agentFallbackModelsToRows(taskConfig.fallback_models);
                    const updateTask = (patch: Record<string, unknown>) => updateAgent({ tasks: buildDreamerTaskPatch(entry, task, patch) });
                    return (
                      <div key={task} className="grid gap-2 rounded-md border border-border/60 p-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <label className="flex items-center gap-2 typography-ui-label text-foreground">
                            <Checkbox
                              checked={enabled}
                              onChange={(checked) => updateAgent({ tasks: toggleDreamerTaskEnabled(entry, task, Boolean(checked)) })}
                              ariaLabel={`enable ${task}`}
                            />
                            {task}
                          </label>
                          <Input
                            value={asString(taskConfig.schedule)}
                            onChange={(event) => updateTask({ schedule: event.target.value })}
                            placeholder={DEFAULT_DREAMER_TASK_SCHEDULES[task] || 'disabled'}
                            className="h-8 max-w-[220px] font-mono"
                          />
                        </div>
                        <div className="grid gap-2 md:grid-cols-3">
                          <Input value={asString(taskConfig.timeout_minutes)} onChange={(event) => updateTask({ timeout_minutes: event.target.value })} placeholder="timeout_minutes" className="h-8" />
                          <Input value={asString(taskConfig.model)} onChange={(event) => updateTask({ model: event.target.value })} placeholder="model" className="h-8 font-mono" />
                          <Input value={asString(taskConfig.thinking_level)} onChange={(event) => updateTask({ thinking_level: event.target.value })} placeholder="thinking_level" className="h-8" />
                        </div>
                        {task === 'review-user-memories' || task === 'promote-primers' ? (
                          <Input value={asString(taskConfig.promotion_threshold)} onChange={(event) => updateTask({ promotion_threshold: event.target.value })} placeholder="promotion_threshold" className="h-8" />
                        ) : null}
                        <Input
                          value={fallbackRowsForTask.map((row) => row.model).join(', ')}
                          onChange={(event) => updateTask({
                            fallback_models: agentFallbackRowsToConfig(event.target.value.split(',').map((model, index) => ({ id: `fallback-${index}`, model }))),
                          })}
                          placeholder="fallback_models comma-separated"
                          className="h-8 font-mono"
                        />
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {agentId === 'sidekick' ? (
              <section className="grid gap-3 rounded-lg border border-border/70 p-3 md:grid-cols-2">
                <Field label="timeout_ms">
                  <Input value={asString(entry.timeout_ms)} onChange={(event) => updateAgent({ timeout_ms: event.target.value })} placeholder="30000" className="h-8" />
                </Field>
                <div className="md:col-span-2">
                  <Field label="system_prompt">
                    <Textarea
                      value={asString(entry.system_prompt)}
                      onChange={(event) => updateAgent({ system_prompt: event.target.value })}
                      rows={4}
                      outerClassName="min-h-[112px]"
                      className="font-mono typography-meta"
                      placeholder={t('settings.magicContext.agentDialog.sidekickSystemPromptPlaceholder')}
                    />
                  </Field>
                </div>
              </section>
            ) : null}

            <section className="grid gap-3">
              <Field label="prompt">
                <Textarea
                  value={asString(entry.prompt)}
                  onChange={(event) => updateAgent({ prompt: event.target.value })}
                  rows={4}
                  outerClassName="min-h-[112px]"
                  className="font-mono typography-meta"
                  placeholder={t('settings.magicContext.agentDialog.promptPlaceholder')}
                />
              </Field>
              <Field label="description">
                <Input value={asString(entry.description)} onChange={(event) => updateAgent({ description: event.target.value })} placeholder={t('settings.magicContext.agentDialog.descriptionPlaceholder')} className="h-8" />
              </Field>
              <JsonTextareaField label="tools" value={entry.tools} onChange={(value) => updateAgent({ tools: value })} placeholder={t('settings.magicContext.agentDialog.toolsPlaceholder')} />
              <JsonTextareaField label="permission" value={entry.permission} onChange={(value) => updateAgent({ permission: value })} placeholder={t('settings.magicContext.agentDialog.permissionPlaceholder')} />
            </section>
          </div>
        </div>

        <DialogFooter className="border-t border-border/70 px-5 py-3">
          <Button type="button" variant="outline" onClick={() => agentId && resetKey(agentId)}>
            <RiRestartLine className="h-3.5 w-3.5" />
            {t('settings.magicContext.actions.resetItem')}
          </Button>
          <Button type="button" onClick={onClose}>{t('settings.magicContext.actions.done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const stringArrayToText = (value: unknown): string => (
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join('\n') : ''
);

const textToStringArray = (value: string): string[] | undefined => {
  const entries = value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? Array.from(new Set(entries)) : undefined;
};

function SystemPromptInjectionSection({
  draft,
  projectOverrides,
}: {
  draft: MagicContextConfig;
  projectOverrides: Set<string>;
}) {
  const { t } = useI18n();
  const updateDraftPath = useMagicContextConfigStore((state) => state.updateDraftPath);
  const resetKey = useMagicContextConfigStore((state) => state.resetKey);
  const injection = asRecord(draft.system_prompt_injection);
  const normalized = normalizeMagicContextConfig(draft);

  return (
    <Section title={t('settings.magicContext.systemPrompt.title')} description={t('settings.magicContext.systemPrompt.description')}>
      <div className="grid gap-3 border-t border-border/50 px-3 py-3 first:border-t-0 lg:grid-cols-[minmax(220px,0.8fr)_minmax(320px,1.2fr)]">
        <div className="rounded-md border border-border/70 p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <div className="typography-ui-label font-medium text-foreground">system_prompt_injection</div>
              <div className="typography-micro text-muted-foreground">{t('settings.magicContext.systemPrompt.cardDescription')}</div>
            </div>
            <div className="flex items-center gap-1">
              {normalized.system_prompt_injection ? <Badge className="bg-primary/10 text-primary">{t('settings.magicContext.badge.overridden')}</Badge> : null}
              {projectOverrides.has('system_prompt_injection') ? <Badge className="bg-[var(--status-warning)]/10 text-[var(--status-warning)]">{t('settings.magicContext.badge.projectOverride')}</Badge> : null}
              <Button type="button" size="icon" variant="ghost" onClick={() => resetKey('system_prompt_injection')} title={t('settings.magicContext.actions.removeOverride')}>
                <RiRestartLine className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <Field label="enabled">
            <BooleanOverrideSelect
              value={injection.enabled}
              onChange={(value) => updateDraftPath(['system_prompt_injection', 'enabled'], value)}
            />
          </Field>
        </div>

        <div className="rounded-md border border-border/70 p-3">
          <Field label="skip_signatures" hint={t('settings.magicContext.systemPrompt.skipSignaturesHint')}>
            <Textarea
              value={stringArrayToText(injection.skip_signatures)}
              onChange={(event) => updateDraftPath(['system_prompt_injection', 'skip_signatures'], textToStringArray(event.target.value))}
              rows={5}
              outerClassName="min-h-[132px]"
              className="font-mono typography-meta"
              placeholder={'signature-a\nsignature-b'}
            />
          </Field>
        </div>
      </div>
    </Section>
  );
}

function EmbeddingMemorySection({
  draft,
  projectOverrides,
}: {
  draft: MagicContextConfig;
  projectOverrides: Set<string>;
}) {
  const { t } = useI18n();
  const updateDraftPath = useMagicContextConfigStore((state) => state.updateDraftPath);
  const resetKey = useMagicContextConfigStore((state) => state.resetKey);
  const embedding = asRecord(draft.embedding);
  const memory = asRecord(draft.memory);
  const autoSearch = asRecord(memory.auto_search);
  const gitIndexing = asRecord(memory.git_commit_indexing);
  const normalized = normalizeMagicContextConfig(draft);

  return (
    <Section title={t('settings.magicContext.embeddingMemory.title')} description={t('settings.magicContext.embeddingMemory.description')}>
      <div className="grid gap-3 border-t border-border/50 px-3 py-3 first:border-t-0 lg:grid-cols-2">
        <div className="rounded-md border border-border/70 p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <div className="typography-ui-label font-medium text-foreground">embedding</div>
              <div className="typography-micro text-muted-foreground">{t('settings.magicContext.embedding.description')}</div>
            </div>
            <div className="flex items-center gap-1">
              {normalized.embedding ? <Badge className="bg-primary/10 text-primary">{t('settings.magicContext.badge.overridden')}</Badge> : null}
              {projectOverrides.has('embedding') ? <Badge className="bg-[var(--status-warning)]/10 text-[var(--status-warning)]">{t('settings.magicContext.badge.projectOverride')}</Badge> : null}
              <Button type="button" size="icon" variant="ghost" onClick={() => resetKey('embedding')} title={t('settings.magicContext.actions.removeOverride')}>
                <RiRestartLine className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="grid gap-3">
            <Field label="provider">
              <Select
                value={asString(embedding.provider) || INHERIT_VALUE}
                onValueChange={(value) => updateDraftPath(['embedding', 'provider'], value === INHERIT_VALUE ? undefined : value)}
              >
                <SelectTrigger className="h-8 w-full" size="lg">
                  <SelectValue>{(value) => value === INHERIT_VALUE ? t('settings.magicContext.common.inherit') : value}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT_VALUE}>{t('settings.magicContext.common.inherit')}</SelectItem>
                  {EMBEDDING_PROVIDERS.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="model">
              <Input value={asString(embedding.model)} onChange={(event) => updateDraftPath(['embedding', 'model'], event.target.value)} placeholder="text-embedding-3-large" className="h-8 font-mono" />
            </Field>
            <Field label="endpoint">
              <Input value={asString(embedding.endpoint)} onChange={(event) => updateDraftPath(['embedding', 'endpoint'], event.target.value)} placeholder="https://api.example.com/v1/embeddings" className="h-8 font-mono" />
            </Field>
            <Field label="api_key">
              <Input value={asString(embedding.api_key)} onChange={(event) => updateDraftPath(['embedding', 'api_key'], event.target.value)} placeholder={t('settings.magicContext.common.optional')} className="h-8 font-mono" type="password" />
            </Field>
            <Field label="input_type">
              <Input value={asString(embedding.input_type)} onChange={(event) => updateDraftPath(['embedding', 'input_type'], event.target.value)} placeholder="search_document" className="h-8 font-mono" />
            </Field>
            <Field label="query_input_type">
              <Input value={asString(embedding.query_input_type)} onChange={(event) => updateDraftPath(['embedding', 'query_input_type'], event.target.value)} placeholder="search_query" className="h-8 font-mono" />
            </Field>
            <Field label="truncate">
              <Input value={asString(embedding.truncate)} onChange={(event) => updateDraftPath(['embedding', 'truncate'], event.target.value)} placeholder="END / START / NONE" className="h-8 font-mono" />
            </Field>
            <Field label="max_input_tokens">
              <Input value={asString(embedding.max_input_tokens)} onChange={(event) => updateDraftPath(['embedding', 'max_input_tokens'], event.target.value)} placeholder="8192" className="h-8" />
            </Field>
          </div>
        </div>

        <div className="rounded-md border border-border/70 p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <div className="typography-ui-label font-medium text-foreground">memory</div>
              <div className="typography-micro text-muted-foreground">{t('settings.magicContext.memory.description')}</div>
            </div>
            <div className="flex items-center gap-1">
              {normalized.memory ? <Badge className="bg-primary/10 text-primary">{t('settings.magicContext.badge.overridden')}</Badge> : null}
              {projectOverrides.has('memory') ? <Badge className="bg-[var(--status-warning)]/10 text-[var(--status-warning)]">{t('settings.magicContext.badge.projectOverride')}</Badge> : null}
              <Button type="button" size="icon" variant="ghost" onClick={() => resetKey('memory')} title={t('settings.magicContext.actions.removeOverride')}>
                <RiRestartLine className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="grid gap-3">
            <Field label="enabled">
              <BooleanOverrideSelect value={memory.enabled} onChange={(value) => updateDraftPath(['memory', 'enabled'], value)} />
            </Field>
            <Field label="auto_promote">
              <BooleanOverrideSelect value={memory.auto_promote} onChange={(value) => updateDraftPath(['memory', 'auto_promote'], value)} />
            </Field>
            <Field label="injection_budget_tokens">
              <Input value={asString(memory.injection_budget_tokens)} onChange={(event) => updateDraftPath(['memory', 'injection_budget_tokens'], event.target.value)} placeholder="4000" className="h-8" />
            </Field>
            <Field label="retrieval_count_promotion_threshold">
              <Input value={asString(memory.retrieval_count_promotion_threshold)} onChange={(event) => updateDraftPath(['memory', 'retrieval_count_promotion_threshold'], event.target.value)} placeholder="3" className="h-8" />
            </Field>
            <div className="grid gap-2 rounded-md border border-border/60 p-2">
              <Field label="auto_search.enabled">
                <BooleanOverrideSelect value={autoSearch.enabled} onChange={(value) => updateDraftPath(['memory', 'auto_search', 'enabled'], value)} />
              </Field>
              <Input value={asString(autoSearch.score_threshold)} onChange={(event) => updateDraftPath(['memory', 'auto_search', 'score_threshold'], event.target.value)} placeholder="score_threshold 0.3..0.95" className="h-8" />
              <Input value={asString(autoSearch.min_prompt_chars)} onChange={(event) => updateDraftPath(['memory', 'auto_search', 'min_prompt_chars'], event.target.value)} placeholder="min_prompt_chars 5..500" className="h-8" />
            </div>
            <div className="grid gap-2 rounded-md border border-border/60 p-2">
              <Field label="git_commit_indexing.enabled">
                <BooleanOverrideSelect value={gitIndexing.enabled} onChange={(value) => updateDraftPath(['memory', 'git_commit_indexing', 'enabled'], value)} />
              </Field>
              <Input value={asString(gitIndexing.since_days)} onChange={(event) => updateDraftPath(['memory', 'git_commit_indexing', 'since_days'], event.target.value)} placeholder="since_days 7..3650" className="h-8" />
              <Input value={asString(gitIndexing.max_commits)} onChange={(event) => updateDraftPath(['memory', 'git_commit_indexing', 'max_commits'], event.target.value)} placeholder="max_commits 100..20000" className="h-8" />
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}

function OperationsSection({
  draft,
  projectOverrides,
}: {
  draft: MagicContextConfig;
  projectOverrides: Set<string>;
}) {
  const { t } = useI18n();
  const updateDraftPath = useMagicContextConfigStore((state) => state.updateDraftPath);
  const resetKey = useMagicContextConfigStore((state) => state.resetKey);
  const commitCluster = asRecord(draft.commit_cluster_trigger);
  const caveman = asRecord(draft.caveman_text_compression);
  const sqlite = asRecord(draft.sqlite);
  const normalized = normalizeMagicContextConfig(draft);

  return (
    <Section title={t('settings.magicContext.operations.title')} description={t('settings.magicContext.operations.description')}>
      <div className="grid gap-3 border-t border-border/50 px-3 py-3 lg:grid-cols-3">
        <div className="rounded-md border border-border/70 p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <div className="typography-ui-label font-medium text-foreground">commit_cluster_trigger</div>
              <div className="typography-micro text-muted-foreground">{t('settings.magicContext.operations.commitCluster.description')}</div>
            </div>
            <div className="flex items-center gap-1">
              {normalized.commit_cluster_trigger ? <Badge className="bg-primary/10 text-primary">{t('settings.magicContext.badge.overridden')}</Badge> : null}
              {projectOverrides.has('commit_cluster_trigger') ? <Badge className="bg-[var(--status-warning)]/10 text-[var(--status-warning)]">{t('settings.magicContext.badge.projectOverride')}</Badge> : null}
              <Button type="button" size="icon" variant="ghost" onClick={() => resetKey('commit_cluster_trigger')} title={t('settings.magicContext.actions.removeOverride')}>
                <RiRestartLine className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="grid gap-3">
            <Field label="enabled">
              <BooleanOverrideSelect value={commitCluster.enabled} onChange={(value) => updateDraftPath(['commit_cluster_trigger', 'enabled'], value)} />
            </Field>
            <Field label="min_clusters">
              <Input value={asString(commitCluster.min_clusters)} onChange={(event) => updateDraftPath(['commit_cluster_trigger', 'min_clusters'], event.target.value)} placeholder="3" className="h-8" />
            </Field>
          </div>
        </div>

        <div className="rounded-md border border-border/70 p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <div className="typography-ui-label font-medium text-foreground">caveman_text_compression</div>
              <div className="typography-micro text-muted-foreground">Stable text compression thresholds.</div>
            </div>
            <div className="flex items-center gap-1">
              {normalized.caveman_text_compression ? <Badge className="bg-primary/10 text-primary">{t('settings.magicContext.badge.overridden')}</Badge> : null}
              {projectOverrides.has('caveman_text_compression') ? <Badge className="bg-[var(--status-warning)]/10 text-[var(--status-warning)]">{t('settings.magicContext.badge.projectOverride')}</Badge> : null}
              <Button type="button" size="icon" variant="ghost" onClick={() => resetKey('caveman_text_compression')} title={t('settings.magicContext.actions.removeOverride')}>
                <RiRestartLine className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="grid gap-3">
            <Field label="enabled">
              <BooleanOverrideSelect value={caveman.enabled} onChange={(value) => updateDraftPath(['caveman_text_compression', 'enabled'], value)} />
            </Field>
            <Field label="min_chars">
              <Input value={asString(caveman.min_chars)} onChange={(event) => updateDraftPath(['caveman_text_compression', 'min_chars'], event.target.value)} placeholder="100..10000" className="h-8" />
            </Field>
          </div>
        </div>

        <div className="rounded-md border border-border/70 p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <div className="typography-ui-label font-medium text-foreground">sqlite</div>
              <div className="typography-micro text-muted-foreground">SQLite cache and mmap limits.</div>
            </div>
            <div className="flex items-center gap-1">
              {normalized.sqlite ? <Badge className="bg-primary/10 text-primary">{t('settings.magicContext.badge.overridden')}</Badge> : null}
              {projectOverrides.has('sqlite') ? <Badge className="bg-[var(--status-warning)]/10 text-[var(--status-warning)]">{t('settings.magicContext.badge.projectOverride')}</Badge> : null}
              <Button type="button" size="icon" variant="ghost" onClick={() => resetKey('sqlite')} title={t('settings.magicContext.actions.removeOverride')}>
                <RiRestartLine className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="grid gap-3">
            <Field label="cache_size_mb">
              <Input value={asString(sqlite.cache_size_mb)} onChange={(event) => updateDraftPath(['sqlite', 'cache_size_mb'], event.target.value)} placeholder="2..2048" className="h-8" />
            </Field>
            <Field label="mmap_size_mb">
              <Input value={asString(sqlite.mmap_size_mb)} onChange={(event) => updateDraftPath(['sqlite', 'mmap_size_mb'], event.target.value)} placeholder="0..8192" className="h-8" />
            </Field>
          </div>
        </div>
      </div>
    </Section>
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
  draft: MagicContextConfig;
  expectedMtimeMs: number | null;
}) {
  const { t } = useI18n();
  const preview = React.useMemo(() => {
    const payload = buildMagicContextSavePayload(expectedMtimeMs, draft);
    return JSON.stringify(payload.config, null, 2);
  }, [draft, expectedMtimeMs]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('settings.magicContext.jsonPreview.title')}</DialogTitle>
          <DialogDescription>{t('settings.magicContext.jsonPreview.description')}</DialogDescription>
        </DialogHeader>
        <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border/70 bg-[var(--surface-elevated)] p-3 font-mono typography-meta text-foreground">
          {preview}
        </pre>
      </DialogContent>
    </Dialog>
  );
}

export const MagicContextPage: React.FC = () => {
  const { t } = useI18n();
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const config = useMagicContextConfigStore((state) => state.config);
  const draft = useMagicContextConfigStore((state) => state.draft);
  const initialDraft = useMagicContextConfigStore((state) => state.initialDraft);
  const isLoading = useMagicContextConfigStore((state) => state.isLoading);
  const isSaving = useMagicContextConfigStore((state) => state.isSaving);
  const error = useMagicContextConfigStore((state) => state.error);
  const loadConfig = useMagicContextConfigStore((state) => state.loadConfig);
  const saveChanges = useMagicContextConfigStore((state) => state.saveChanges);
  const discardChanges = useMagicContextConfigStore((state) => state.discardChanges);

  const [editingAgent, setEditingAgent] = React.useState<MagicAgentId | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = React.useState(false);

  React.useEffect(() => {
    void loadConfig({ force: true });
    void useConfigStore.getState().loadProviders();
  }, [activeProjectId, loadConfig]);

  const hasChanges = hasMagicContextDraftChanges(initialDraft, draft);
  const ignoredProjectKeys = React.useMemo(
    () => config?.diagnostics?.project?.ignoredUserOnlyKeys ?? [],
    [config],
  );
  const projectOverrides = React.useMemo(() => {
    const ignored = new Set(ignoredProjectKeys);
    return new Set((config?.project.overriddenKeys ?? []).filter((key) => !ignored.has(key)));
  }, [config, ignoredProjectKeys]);
  const projectOverrideCount = projectOverrides.size;

  const handleReload = async () => {
    if (hasChanges && typeof window !== 'undefined' && !window.confirm(t('settings.magicContext.confirm.reloadDiscard'))) {
      return;
    }
    const ok = await loadConfig({ force: true });
    if (!ok) {
      toast.error(t('settings.magicContext.toast.loadFailed'));
      return;
    }
    toast.success(t('settings.magicContext.toast.reloaded'));
  };

  const handleSave = async () => {
    const result = await saveChanges();
    if (!result.ok) {
      if (result.conflict) {
        toast.error(t('settings.magicContext.toast.conflict'));
      } else {
        toast.error(result.message || t('settings.magicContext.toast.saveFailed'));
      }
      return;
    }
    toast.success(t('settings.magicContext.toast.saved'));
  };

  return (
    <SettingsPageLayout className="max-w-6xl space-y-4">
      <div className="space-y-1">
        <h2 className="typography-ui-header font-semibold text-foreground">
          {t('settings.page.magicContext.title')}
        </h2>
        <p className="typography-ui text-muted-foreground">
          {t('settings.magicContext.description')}
        </p>
      </div>

      <div className="rounded-lg border border-border/70 bg-[var(--surface-elevated)] px-3 py-2">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge className={config?.plugin.detected ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}>
                {config?.plugin.detected ? t('settings.magicContext.badge.pluginDetected') : t('settings.magicContext.badge.pluginMissing')}
              </Badge>
              {projectOverrideCount > 0 ? (
                <Badge className="bg-[var(--status-warning)]/10 text-[var(--status-warning)]">
                  {t('settings.magicContext.badge.projectOverrideCount', { count: projectOverrideCount })}
                </Badge>
              ) : null}
              {ignoredProjectKeys.length > 0 ? (
                <Badge className="bg-[var(--status-warning)]/10 text-[var(--status-warning)]">
                  {t('settings.magicContext.badge.projectIgnored', { keys: ignoredProjectKeys.join(', ') })}
                </Badge>
              ) : null}
              {hasChanges ? <Badge className="bg-primary/10 text-primary">{t('settings.magicContext.badge.unsavedChanges')}</Badge> : null}
            </div>
            <div className="break-all font-mono typography-micro text-muted-foreground">
              {config?.target.path ?? t('settings.magicContext.state.readingConfigPath')}
            </div>
            {config?.project.exists ? (
              <div className="break-all typography-micro text-[var(--status-warning)]">
                {t('settings.magicContext.project.overrideAt', { path: config.project.path })}
              </div>
            ) : null}
            {error ? <div className="typography-micro text-[var(--status-error)]">{error}</div> : null}
            <DiagnosticsPanel config={config} ignoredProjectKeys={ignoredProjectKeys} />
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Button type="button" size="xs" variant="outline" onClick={handleReload} disabled={isLoading || isSaving}>
              <RiRefreshLine className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
              {t('settings.magicContext.actions.reload')}
            </Button>
            <Button type="button" size="xs" variant="outline" onClick={() => setIsPreviewOpen(true)}>
              <RiCodeLine className="h-3.5 w-3.5" />
              {t('settings.magicContext.actions.jsonPreview')}
            </Button>
            <Button type="button" size="xs" variant="outline" onClick={discardChanges} disabled={!hasChanges || isSaving}>
              {t('settings.magicContext.actions.discardChanges')}
            </Button>
            <Button type="button" size="xs" onClick={handleSave} disabled={!hasChanges || isSaving}>
              {isSaving ? <RiRefreshLine className="h-3.5 w-3.5 animate-spin" /> : <RiSaveLine className="h-3.5 w-3.5" />}
              {isSaving ? t('settings.magicContext.actions.saving') : t('settings.magicContext.actions.saveChanges')}
            </Button>
          </div>
        </div>
      </div>

      <Section title={t('settings.magicContext.section.core.title')} description={t('settings.magicContext.section.core.description')}>
        <BooleanRow field="enabled" label="enabled" description={t('settings.magicContext.field.enabled.description')} draft={draft} projectOverrides={projectOverrides} />
        <BooleanRow field="auto_update" label="auto_update" description={t('settings.magicContext.field.autoUpdate.description')} draft={draft} projectOverrides={projectOverrides} />
        <BooleanRow field="ctx_reduce_enabled" label="ctx_reduce_enabled" description={t('settings.magicContext.field.ctxReduce.description')} draft={draft} projectOverrides={projectOverrides} />
        <BooleanRow field="temporal_awareness" label="temporal_awareness" description="Include temporal awareness hints in Magic Context behavior." draft={draft} projectOverrides={projectOverrides} />
        <BooleanRow field="keep_subagents" label="keep_subagents" description="Keep subagent context available for Magic Context." draft={draft} projectOverrides={projectOverrides} />
        <ScalarRow field="toast_duration_ms" label="toast_duration_ms" description="Toast duration in milliseconds (0..60000)." placeholder="5000" draft={draft} projectOverrides={projectOverrides} />
        <MapEditor field="cache_ttl" label="cache_ttl" description={t('settings.magicContext.field.cacheTtl.description')} draft={draft} projectOverrides={projectOverrides} type="string" allowScalar valuePlaceholder="5m / 60m" />
        <MapEditor field="execute_threshold_percentage" label="execute_threshold_percentage" description={t('settings.magicContext.field.executeThresholdPercentage.description')} draft={draft} projectOverrides={projectOverrides} type="number" allowScalar valuePlaceholder="65" />
        <MapEditor field="execute_threshold_tokens" label="execute_threshold_tokens" description={t('settings.magicContext.field.executeThresholdTokens.description')} draft={draft} projectOverrides={projectOverrides} type="number" allowScalar={false} valuePlaceholder="150000" />
      </Section>

      <Section title={t('settings.magicContext.section.cleanup.title')} description={t('settings.magicContext.section.cleanup.description')}>
        <ScalarRow field="protected_tags" label="protected_tags" description={t('settings.magicContext.field.protectedTags.description')} placeholder="20" draft={draft} projectOverrides={projectOverrides} />
        <ScalarRow field="clear_reasoning_age" label="clear_reasoning_age" description={t('settings.magicContext.field.clearReasoningAge.description')} placeholder="50" draft={draft} projectOverrides={projectOverrides} />
        <ScalarRow field="history_budget_percentage" label="history_budget_percentage" description={t('settings.magicContext.field.historyBudgetPercentage.description')} placeholder="0.15" draft={draft} projectOverrides={projectOverrides} />
        <ScalarRow field="historian_timeout_ms" label="historian_timeout_ms" description={t('settings.magicContext.field.historianTimeout.description')} placeholder="300000" draft={draft} projectOverrides={projectOverrides} />
      </Section>

      <Section title={t('settings.magicContext.section.agents.title')} description={t('settings.magicContext.section.agents.description')}>
        <div className="grid gap-3 border-t border-border/50 p-3 first:border-t-0">
          {AGENT_DEFINITIONS.map((agent) => (
            <AgentCard
              key={agent.id}
              {...agent}
              draft={draft}
              projectOverrides={projectOverrides}
              onEdit={setEditingAgent}
            />
          ))}
        </div>
      </Section>

      <SystemPromptInjectionSection draft={draft} projectOverrides={projectOverrides} />
      <EmbeddingMemorySection draft={draft} projectOverrides={projectOverrides} />
      <OperationsSection draft={draft} projectOverrides={projectOverrides} />

      <AgentAdvancedDialog agentId={editingAgent} onClose={() => setEditingAgent(null)} />
      <JsonPreviewDialog
        open={isPreviewOpen}
        onOpenChange={setIsPreviewOpen}
        draft={draft}
        expectedMtimeMs={config?.target.mtimeMs ?? null}
      />
    </SettingsPageLayout>
  );
};
