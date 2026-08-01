import React from 'react';
import {
  RiArrowDownSLine,
  RiCodeLine,
  RiRefreshLine,
  RiSaveLine,
  RiSparklingLine,
} from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
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
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useAgentOrchestrationStore } from '@/stores/useAgentOrchestrationStore';
import type { AgentOrchestrationConfigResponse } from '@/stores/useAgentOrchestrationStore';
import { useSlimConfigStore } from '@/stores/useSlimConfigStore';
import { usePluginsStore } from '@/stores/usePluginsStore';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import {
  buildSlimSavePayload,
  countFallbackChains,
  getActivePreset,
  getModelString,
  getPresetAgent,
  hasSlimDraftChanges,
  joinModelRef,
  normalizeMultiplexerLayout,
  normalizeMultiplexerType,
  normalizeNumberInput,
  normalizeVariant,
  parseModelRef,
  SLIM_AGENT_DEFINITIONS,
  type SlimAgentItem,
  type SlimMode,
  type SlimRawConfig,
} from './slimConfig';

const INHERIT_VALUE = '__inherit__';
const VARIANT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MULTIPLEXER_TYPES = ['none', 'auto', 'tmux', 'zellij'];
const MULTIPLEXER_LAYOUTS = ['main-vertical', 'main-horizontal', 'tiled', 'even-horizontal', 'even-vertical'];

function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex h-5 shrink-0 items-center rounded px-1.5 typography-micro font-medium', className)}>
      {children}
    </span>
  );
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="typography-ui-label text-foreground">{label}</span>
      {children}
      {hint ? <span className="typography-micro text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

function Section({
  title,
  description,
  defaultOpen,
  children,
}: {
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(Boolean(defaultOpen));
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <section className="overflow-hidden rounded-lg border border-border/70 bg-background">
        <CollapsibleTrigger className="rounded-none border-b border-border/60 px-3 py-2">
          <div className="min-w-0 text-left">
            <h3 className="typography-ui-label font-semibold text-foreground">{title}</h3>
            {description ? <p className="typography-micro text-muted-foreground">{description}</p> : null}
          </div>
          <RiArrowDownSLine className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="p-3">{children}</div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function CompactModelEditor({
  model,
  onChange,
}: {
  model: string;
  onChange: (model: string) => void;
}) {
  const { t } = useI18n();
  const parsed = parseModelRef(model);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <ModelSelector
        providerId={parsed.providerId}
        modelId={parsed.modelId}
        onChange={(providerId, modelId) => onChange(joinModelRef(providerId, modelId))}
        placeholder={t('settings.agentOrchestration.model.inheritDefault')}
        className="h-7 min-w-[130px] max-w-[230px] flex-1"
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

function parseCommaList(value: string): string[] | undefined {
  const entries = value.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

function formatCommaList(value: unknown): string {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean).join(', ') : '';
}

function DelimitedListInput({
  value,
  onChange,
  placeholder,
  title,
  className,
}: {
  value: unknown;
  onChange: (value: string[] | undefined) => void;
  placeholder: string;
  title?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const formattedValue = React.useMemo(() => formatCommaList(value), [value]);
  const [isFocused, setIsFocused] = React.useState(false);
  const [draftValue, setDraftValue] = React.useState(formattedValue);

  React.useEffect(() => {
    if (!isFocused) {
      setDraftValue(formattedValue);
    }
  }, [formattedValue, isFocused]);

  const displayedValue = isFocused ? draftValue : formattedValue;

  return (
    <Input
      value={displayedValue}
      onFocus={() => {
        setIsFocused(true);
        setDraftValue(formattedValue);
      }}
      onChange={(event) => {
        const nextValue = event.target.value;
        setDraftValue(nextValue);
        onChange(parseCommaList(nextValue));
      }}
      onBlur={() => {
        setIsFocused(false);
        setDraftValue(formatCommaList(parseCommaList(draftValue)));
      }}
      placeholder={placeholder}
      title={title ?? t('settings.agentOrchestration.list.delimitedTitle')}
      className={className}
    />
  );
}

function stringifyJson(value: unknown): string {
  if (value === undefined || value === null) return '';
  return JSON.stringify(value, null, 2);
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON object required');
  }
  return parsed as Record<string, unknown>;
}

function ModeButton({
  id,
  active,
  current,
  title,
  description,
  metadata,
  disabled,
  onSelect,
}: {
  id: string;
  active: boolean;
  current: string;
  title: string;
  description: string;
  metadata?: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const selected = active || current === id;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect(id)}
      className={cn(
        'min-h-[72px] rounded-lg border px-3 py-2 text-left transition-colors',
        selected ? 'border-primary bg-primary/10 text-foreground' : 'border-border/70 bg-background hover:bg-[var(--interactive-hover)]',
        disabled && 'opacity-60',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="typography-ui-label font-semibold">{title}</span>
        {selected ? <Badge className="bg-primary text-primary-foreground">{t('settings.agentOrchestration.badge.current')}</Badge> : null}
      </div>
      <div className="mt-1 typography-micro text-muted-foreground">{description}</div>
      {metadata ? <div className="mt-2 typography-micro text-muted-foreground/80">{metadata}</div> : null}
    </button>
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
  draft: SlimRawConfig;
  expectedMtimeMs: number | null;
}) {
  const { t } = useI18n();
  const preview = React.useMemo(() => JSON.stringify(buildSlimSavePayload(expectedMtimeMs, draft), null, 2), [draft, expectedMtimeMs]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('settings.agentOrchestration.slim.jsonPreviewTitle')}</DialogTitle>
        </DialogHeader>
        <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border/70 bg-[var(--surface-elevated)] p-3 font-mono typography-meta text-foreground">
          {preview}
        </pre>
      </DialogContent>
    </Dialog>
  );
}

function AgentAdvancedDialog({
  agentId,
  onClose,
}: {
  agentId: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const draft = useSlimConfigStore((state) => state.draft);
  const updatePresetAgent = useSlimConfigStore((state) => state.updatePresetAgent);
  const agent = agentId ? getPresetAgent(draft, agentId) : {};
  const [optionsText, setOptionsText] = React.useState('');

  React.useEffect(() => {
    setOptionsText(stringifyJson(agent.options));
  }, [agentId, agent.options]);

  const handleSaveOptions = () => {
    if (!agentId) return;
    try {
      updatePresetAgent(agentId, { options: parseJsonObject(optionsText) });
      toast.success(t('settings.agentOrchestration.toast.optionsUpdated'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.agentOrchestration.toast.jsonParseFailed'));
    }
  };

  return (
    <Dialog open={Boolean(agentId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('settings.agentOrchestration.agentDialog.title', { agentId: agentId ?? '' })}</DialogTitle>
        </DialogHeader>
        {agentId ? (
          <div className="grid gap-3">
            <Field label={t('settings.agentOrchestration.field.displayName')}>
              <Input
                value={typeof agent.displayName === 'string' ? agent.displayName : ''}
                onChange={(event) => updatePresetAgent(agentId, { displayName: event.target.value || undefined })}
                placeholder={t('settings.agentOrchestration.model.inherit')}
              />
            </Field>
            <Field label={t('settings.agentOrchestration.agentDialog.customPrompt')}>
              <Textarea
                value={typeof agent.prompt === 'string' ? agent.prompt : ''}
                onChange={(event) => updatePresetAgent(agentId, { prompt: event.target.value || undefined })}
                placeholder={t('settings.agentOrchestration.agentDialog.customPromptPlaceholder')}
                className="min-h-[88px]"
              />
            </Field>
            <Field label={t('settings.agentOrchestration.field.orchestratorPrompt')}>
              <Textarea
                value={typeof agent.orchestratorPrompt === 'string' ? agent.orchestratorPrompt : ''}
                onChange={(event) => updatePresetAgent(agentId, { orchestratorPrompt: event.target.value || undefined })}
                placeholder="@agent-name ..."
                className="min-h-[88px]"
              />
            </Field>
            <Field label="options JSON">
              <Textarea
                value={optionsText}
                onChange={(event) => setOptionsText(event.target.value)}
                placeholder='{ "textVerbosity": "high" }'
                className="min-h-[140px] font-mono typography-meta"
              />
            </Field>
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{t('settings.agentOrchestration.actions.close')}</Button>
          <Button type="button" onClick={handleSaveOptions} disabled={!agentId}>{t('settings.agentOrchestration.actions.saveOptions')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SlimAgentRow({
  item,
  onAdvanced,
}: {
  item: SlimAgentItem;
  onAdvanced: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const draft = useSlimConfigStore((state) => state.draft);
  const updatePresetAgent = useSlimConfigStore((state) => state.updatePresetAgent);
  const setAgentDisabled = useSlimConfigStore((state) => state.setAgentDisabled);
  const agent = getPresetAgent(draft, item.id);
  const model = getModelString(agent.model);
  const fallbackCount = countFallbackChains(draft.fallback, item.id);
  const disabledIds = new Set(Array.isArray(draft.disabled_agents) ? draft.disabled_agents : ['observer']);
  const disabled = disabledIds.has(item.id);

  return (
    <div className="flex flex-col gap-3 border-t border-border/50 px-3 py-3 first:border-t-0 md:flex-row md:flex-wrap md:items-center">
      <div className="min-w-[200px] max-w-full flex-[1_1_100%] lg:flex-[1_1_200px]">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate typography-ui-label font-medium text-foreground">{item.label}</span>
          {disabled ? <Badge className="bg-muted text-muted-foreground">{t('settings.agentOrchestration.badge.disabled')}</Badge> : null}
          {model ? <Badge className="bg-primary/10 text-primary">{t('settings.agentOrchestration.badge.overridden')}</Badge> : null}
          {item.projectOverride ? <Badge className="bg-[var(--status-warning)]/10 text-[var(--status-warning)]">{t('settings.agentOrchestration.badge.projectOverride')}</Badge> : null}
        </div>
        <div className="typography-micro text-muted-foreground">{item.description}</div>
        <div className="truncate font-mono typography-micro text-muted-foreground/80">
          {t('settings.agentOrchestration.agent.defaultPrefix')}: {item.defaultModel ? `${item.defaultModel}${item.defaultVariant ? ` · ${item.defaultVariant}` : ''}` : t('settings.agentOrchestration.model.pluginDefault')}
        </div>
      </div>
      <div className="min-w-[260px] flex-[1_1_100%] lg:flex-[1.5_1_260px]">
        <CompactModelEditor model={model} onChange={(nextModel) => updatePresetAgent(item.id, { model: nextModel || undefined })} />
      </div>
      <div className="flex min-w-[280px] flex-[1_1_100%] flex-wrap items-center gap-1.5 lg:flex-[2_1_280px]">
        <Select
          value={typeof agent.variant === 'string' && agent.variant ? agent.variant : INHERIT_VALUE}
          onValueChange={(value) => updatePresetAgent(item.id, { variant: value === INHERIT_VALUE ? undefined : normalizeVariant(value) })}
        >
          <SelectTrigger className="h-7 w-[112px]" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT_VALUE}>{t('settings.agentOrchestration.model.inherit')}</SelectItem>
            {VARIANT_OPTIONS.map((variant) => <SelectItem key={variant} value={variant}>{variant}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input
          value={agent.temperature == null ? '' : String(agent.temperature)}
          onChange={(event) => updatePresetAgent(item.id, { temperature: normalizeNumberInput(event.target.value, 'temperature') })}
          placeholder="temp"
          className="h-7 w-[70px]"
        />
        <DelimitedListInput
          value={agent.skills}
          onChange={(value) => updatePresetAgent(item.id, { skills: value })}
          placeholder="skills"
          className="h-7 min-w-[100px] flex-1"
        />
        <DelimitedListInput
          value={agent.mcps}
          onChange={(value) => updatePresetAgent(item.id, { mcps: value })}
          placeholder="mcps, e.g. *, !context7"
          title={t('settings.agentOrchestration.list.delimitedExampleTitle')}
          className="h-7 min-w-[100px] flex-1"
        />
        {fallbackCount > 0 ? <Badge className="bg-muted text-muted-foreground">fallback {fallbackCount}</Badge> : null}
        <label className="flex h-7 shrink-0 items-center gap-1.5 rounded border border-border/70 px-2 typography-micro">
          <Checkbox checked={disabled} onChange={(checked) => setAgentDisabled(item.id, checked)} disabled={item.id === 'orchestrator'} />
          {t('settings.agentOrchestration.actions.disable')}
        </label>
        <Button type="button" size="xs" variant="outline" className="shrink-0" onClick={() => onAdvanced(item.id)}>{t('settings.agentOrchestration.actions.advanced')}</Button>
      </div>
    </div>
  );
}

function SlimAgentsSection() {
  const { t } = useI18n();
  const config = useSlimConfigStore((state) => state.config);
  const draft = useSlimConfigStore((state) => state.draft);
  const [advancedAgent, setAdvancedAgent] = React.useState<string | null>(null);
  const knownIds = new Set(SLIM_AGENT_DEFINITIONS.map((agent) => agent.id));
  const items = config?.agents?.length ? config.agents : SLIM_AGENT_DEFINITIONS.map((agent) => ({
    id: agent.id,
    label: agent.label,
    description: agent.description,
    group: agent.group,
    defaultModel: agent.defaultModel ?? null,
    defaultVariant: agent.defaultVariant ?? null,
    disabled: Array.isArray(draft.disabled_agents) && draft.disabled_agents.includes(agent.id),
    projectDisabled: false,
    override: getPresetAgent(draft, agent.id),
    projectOverride: false,
  }));
  const itemIds = new Set(items.map((item) => item.id));
  const rawPreset = draft.presets?.[getActivePreset(draft)] ?? {};
  const customItems: SlimAgentItem[] = Object.keys(rawPreset)
    .filter((id) => !knownIds.has(id) && !itemIds.has(id))
    .sort()
    .map((id) => ({
      id,
      label: id,
      description: t('settings.agentOrchestration.group.customUnknown'),
      group: 'custom',
      defaultModel: null,
      defaultVariant: null,
      disabled: Array.isArray(draft.disabled_agents) && draft.disabled_agents.includes(id),
      projectDisabled: false,
      override: getPresetAgent(draft, id),
      projectOverride: false,
    }));
  const allItems = [...items.filter((item) => item.group !== 'custom'), ...items.filter((item) => item.group === 'custom'), ...customItems];

  return (
    <section className="overflow-hidden rounded-lg border border-border/70 bg-background">
      <div className="border-b border-border/70 px-3 py-2">
        <h3 className="typography-ui-label font-semibold text-foreground">{t('settings.agentOrchestration.slim.agentRoutingTitle')}</h3>
        <p className="typography-micro text-muted-foreground">{t('settings.agentOrchestration.slim.agentRoutingDescription')}</p>
      </div>
      {allItems.map((item) => <SlimAgentRow key={item.id} item={item} onAdvanced={setAdvancedAgent} />)}
      <AgentAdvancedDialog agentId={advancedAgent} onClose={() => setAdvancedAgent(null)} />
    </section>
  );
}

function FallbackSection() {
  const { t } = useI18n();
  const draft = useSlimConfigStore((state) => state.draft);
  const updateDraftPath = useSlimConfigStore((state) => state.updateDraftPath);
  const fallback = (draft.fallback ?? {}) as Record<string, unknown>;
  const chains = (fallback.chains && typeof fallback.chains === 'object' && !Array.isArray(fallback.chains) ? fallback.chains : {}) as Record<string, unknown>;

  return (
    <Section title={t('settings.agentOrchestration.fallback.title')} description={t('settings.agentOrchestration.fallback.description')}>
      <div className="grid gap-3 lg:grid-cols-4">
        <label className="flex h-9 items-center gap-2 rounded-md border border-border/70 px-2">
          <Checkbox checked={fallback.enabled !== false} onChange={(checked) => updateDraftPath(['fallback', 'enabled'], checked)} />
          <span className="typography-ui">{t('settings.agentOrchestration.fallback.enable')}</span>
        </label>
        <Field label={t('settings.agentOrchestration.field.timeoutMs')}>
          <Input value={fallback.timeoutMs == null ? '' : String(fallback.timeoutMs)} onChange={(event) => updateDraftPath(['fallback', 'timeoutMs'], normalizeNumberInput(event.target.value))} placeholder="15000" />
        </Field>
        <Field label={t('settings.agentOrchestration.field.retryDelayMs')}>
          <Input value={fallback.retryDelayMs == null ? '' : String(fallback.retryDelayMs)} onChange={(event) => updateDraftPath(['fallback', 'retryDelayMs'], normalizeNumberInput(event.target.value))} placeholder="500" />
        </Field>
        <label className="flex h-9 items-center gap-2 rounded-md border border-border/70 px-2">
          <Checkbox checked={fallback.retry_on_empty !== false} onChange={(checked) => updateDraftPath(['fallback', 'retry_on_empty'], checked)} />
          <span className="typography-ui">{t('settings.agentOrchestration.fallback.retryEmpty')}</span>
        </label>
      </div>
      <div className="mt-3 grid gap-2 lg:grid-cols-2">
        {SLIM_AGENT_DEFINITIONS.slice(0, 6).map((agent) => (
          <Field key={agent.id} label={t('settings.agentOrchestration.field.agentChain', { agent: agent.label })}>
            <Input
              value={Array.isArray(chains[agent.id]) ? (chains[agent.id] as string[]).join(', ') : ''}
              onChange={(event) => updateDraftPath(['fallback', 'chains', agent.id], parseCommaList(event.target.value))}
              placeholder="provider/model, provider/fallback"
              className="font-mono typography-meta"
            />
          </Field>
        ))}
      </div>
    </Section>
  );
}

function RuntimeAdvancedSection() {
  const { t } = useI18n();
  const draft = useSlimConfigStore((state) => state.draft);
  const updateDraftPath = useSlimConfigStore((state) => state.updateDraftPath);
  const multiplexer = (draft.multiplexer ?? {}) as Record<string, unknown>;

  return (
    <Section title={t('settings.agentOrchestration.runtime.title')} description={t('settings.agentOrchestration.runtime.description')}>
      <div className="grid gap-3 lg:grid-cols-4">
        <label className="flex h-9 items-center gap-2 rounded-md border border-border/70 px-2">
          <Checkbox checked={draft.autoUpdate === true} onChange={(checked) => updateDraftPath(['autoUpdate'], checked)} />
          <span className="typography-ui">autoUpdate</span>
        </label>
        <Field label={t('settings.agentOrchestration.field.multiplexer')}>
          <Select value={typeof multiplexer.type === 'string' ? multiplexer.type : 'none'} onValueChange={(value) => updateDraftPath(['multiplexer', 'type'], normalizeMultiplexerType(value))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {MULTIPLEXER_TYPES.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('settings.agentOrchestration.field.layout')}>
          <Select value={typeof multiplexer.layout === 'string' ? multiplexer.layout : 'main-vertical'} onValueChange={(value) => updateDraftPath(['multiplexer', 'layout'], normalizeMultiplexerLayout(value))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {MULTIPLEXER_LAYOUTS.map((layout) => <SelectItem key={layout} value={layout}>{layout}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('settings.agentOrchestration.field.mainPanePercent')}>
          <Input value={multiplexer.main_pane_size == null ? '' : String(multiplexer.main_pane_size)} onChange={(event) => updateDraftPath(['multiplexer', 'main_pane_size'], normalizeNumberInput(event.target.value, 'mainPane'))} placeholder="60" />
        </Field>
        <Field label="disabled_mcps">
          <DelimitedListInput value={draft.disabled_mcps} onChange={(value) => updateDraftPath(['disabled_mcps'], value)} placeholder="context7, websearch" />
        </Field>
        <JsonObjectField label="sessionManager" path={['sessionManager']} value={draft.sessionManager} />
        <JsonObjectField label="todoContinuation" path={['todoContinuation']} value={draft.todoContinuation} />
      </div>
    </Section>
  );
}

function JsonObjectField({ label, value, path }: { label: string; value: unknown; path: Array<string | number> }) {
  const { t } = useI18n();
  const updateDraftPath = useSlimConfigStore((state) => state.updateDraftPath);
  const [text, setText] = React.useState(stringifyJson(value));
  React.useEffect(() => setText(stringifyJson(value)), [value]);
  return (
    <Field label={label}>
      <div className="grid gap-1">
        <Textarea value={text} onChange={(event) => setText(event.target.value)} className="min-h-[88px] font-mono typography-meta" placeholder="{}" />
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => {
            try {
              updateDraftPath(path, parseJsonObject(text));
              toast.success(t('settings.agentOrchestration.toast.jsonUpdated', { label }));
            } catch (error) {
              toast.error(error instanceof Error ? error.message : t('settings.agentOrchestration.toast.jsonParseFailed'));
            }
          }}
        >
          {t('settings.agentOrchestration.actions.applyJson')}
        </Button>
      </div>
    </Field>
  );
}

function FeatureAdvancedSection() {
  const { t } = useI18n();
  const draft = useSlimConfigStore((state) => state.draft);
  return (
    <Section title={t('settings.agentOrchestration.features.title')} description={t('settings.agentOrchestration.features.description')}>
      <div className="grid gap-3 lg:grid-cols-3">
        <JsonObjectField label="council" path={['council']} value={draft.council} />
        <JsonObjectField label="divoom" path={['divoom']} value={draft.divoom} />
        <JsonObjectField label="interview" path={['interview']} value={draft.interview} />
      </div>
    </Section>
  );
}

export function SlimPanel() {
  const { t } = useI18n();
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const config = useSlimConfigStore((state) => state.config);
  const draft = useSlimConfigStore((state) => state.draft);
  const initialDraft = useSlimConfigStore((state) => state.initialDraft);
  const isLoading = useSlimConfigStore((state) => state.isLoading);
  const isSaving = useSlimConfigStore((state) => state.isSaving);
  const error = useSlimConfigStore((state) => state.error);
  const loadConfig = useSlimConfigStore((state) => state.loadConfig);
  const saveChanges = useSlimConfigStore((state) => state.saveChanges);
  const discardChanges = useSlimConfigStore((state) => state.discardChanges);
  const updateDraftPath = useSlimConfigStore((state) => state.updateDraftPath);
  const [previewOpen, setPreviewOpen] = React.useState(false);

  React.useEffect(() => {
    void loadConfig({ force: true });
    void useConfigStore.getState().loadProviders();
  }, [activeProjectId, loadConfig]);

  const hasChanges = hasSlimDraftChanges(initialDraft, draft);
  const preset = getActivePreset(draft);
  const presetNames = Array.from(new Set([...(config?.presets ?? []), ...Object.keys(draft.presets ?? {}), preset])).filter(Boolean);

  const handleSave = async () => {
    const result = await saveChanges();
    if (!result.ok) {
      toast.error(result.conflict ? t('settings.agentOrchestration.toast.conflict') : result.message || t('settings.agentOrchestration.toast.slimSaveFailed'));
      return;
    }
    toast.success(t('settings.agentOrchestration.toast.slimSaved'));
  };

  const handleReload = async () => {
    if (hasChanges && typeof window !== 'undefined' && !window.confirm(t('settings.agentOrchestration.confirm.reloadDiscard'))) return;
    const ok = await loadConfig({ force: true });
    if (ok) {
      toast.success(t('settings.agentOrchestration.toast.slimReloaded'));
    } else {
      toast.error(t('settings.agentOrchestration.toast.slimLoadFailed'));
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border/70 bg-[var(--surface-elevated)] px-3 py-2">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge className={config?.plugin.enabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}>
                {config?.plugin.enabled ? t('settings.agentOrchestration.badge.slimEnabled') : t('settings.agentOrchestration.badge.slimDisabled')}
              </Badge>
              {config?.project.exists ? <Badge className="bg-[var(--status-warning)]/10 text-[var(--status-warning)]">{t('settings.agentOrchestration.badge.projectOverride')}</Badge> : null}
              {hasChanges ? <Badge className="bg-primary/10 text-primary">{t('settings.agentOrchestration.badge.unsavedChanges')}</Badge> : null}
            </div>
            <div className="break-all font-mono typography-micro text-muted-foreground">{config?.target.path ?? t('settings.agentOrchestration.state.readingConfigPath')}</div>
            {config?.project.exists ? <div className="break-all typography-micro text-[var(--status-warning)]">{t('settings.agentOrchestration.project.overrideAt', { path: config.project.path })}</div> : null}
            {error ? <div className="typography-micro text-[var(--status-error)]">{error}</div> : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button type="button" size="xs" variant="outline" onClick={handleReload} disabled={isLoading || isSaving}>
              <RiRefreshLine className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
              {t('settings.agentOrchestration.actions.reload')}
            </Button>
            <Button type="button" size="xs" variant="outline" onClick={() => setPreviewOpen(true)}>
              <RiCodeLine className="h-3.5 w-3.5" />
              {t('settings.agentOrchestration.actions.jsonPreview')}
            </Button>
            <Button type="button" size="xs" variant="outline" onClick={discardChanges} disabled={!hasChanges || isSaving}>{t('settings.agentOrchestration.actions.discardChanges')}</Button>
            <Button type="button" size="xs" onClick={handleSave} disabled={!hasChanges || isSaving}>
              {isSaving ? <RiRefreshLine className="h-3.5 w-3.5 animate-spin" /> : <RiSaveLine className="h-3.5 w-3.5" />}
              {isSaving ? t('settings.agentOrchestration.actions.saving') : t('settings.agentOrchestration.actions.saveChanges')}
            </Button>
          </div>
        </div>
      </div>

      <section className="rounded-lg border border-border/70 bg-background p-3">
        <div className="grid gap-3 lg:grid-cols-[minmax(180px,260px)_1fr] lg:items-end">
          <Field label={t('settings.agentOrchestration.field.activePreset')}>
            <Select value={preset} onValueChange={(value) => updateDraftPath(['preset'], value)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {presetNames.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('settings.agentOrchestration.preset.newName')}>
            <Input
              placeholder={t('settings.agentOrchestration.preset.newPlaceholder')}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                const value = event.currentTarget.value.trim();
                if (!value) return;
                updateDraftPath(['preset'], value);
                updateDraftPath(['presets', value], {});
                event.currentTarget.value = '';
              }}
            />
          </Field>
        </div>
      </section>

      <SlimAgentsSection />
      <FallbackSection />
      <RuntimeAdvancedSection />
      <FeatureAdvancedSection />
      <JsonPreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} draft={draft} expectedMtimeMs={config?.target.mtimeMs ?? null} />
    </div>
  );
}

type OrchestrationProvider = AgentOrchestrationConfigResponse['providers'][number];

function getProviderSelectionId(provider: OrchestrationProvider): string {
  return provider.legacyMode ?? `provider:${provider.id}`;
}

function getProviderTitle(provider: OrchestrationProvider, t: ReturnType<typeof useI18n>['t']): string {
  if (provider.id === 'oh-my-opencode-slim') return t('settings.agentOrchestration.provider.slim.title');
  if (provider.id === 'oh-my-openagent') return t('settings.agentOrchestration.provider.openagent.title');
  return provider.title;
}

function getProviderDescription(provider: OrchestrationProvider, t: ReturnType<typeof useI18n>['t']): string {
  if (provider.id === 'oh-my-opencode-slim') return t('settings.agentOrchestration.provider.slim.description');
  if (provider.id === 'oh-my-openagent') return t('settings.agentOrchestration.provider.openagent.description');
  if (provider.description?.trim()) return provider.description.trim();
  if (provider.known === false) return t('settings.agentOrchestration.mode.generic.description');
  return t('settings.agentOrchestration.mode.provider.description');
}

function getProviderMetadata(provider: OrchestrationProvider, t: ReturnType<typeof useI18n>['t']): string | null {
  if (provider.known === false) return t('settings.agentOrchestration.mode.generic.metadata');
  if (!provider.active && (provider.remembered || provider.installed)) return t('settings.agentOrchestration.mode.provider.inactive');
  if (!provider.installed) return t('settings.agentOrchestration.mode.provider.notInstalled');
  return null;
}

function shouldShowProvider(provider: OrchestrationProvider): boolean {
  return provider.active || provider.installed || provider.remembered === true || provider.known === false;
}

export const AgentOrchestrationPage: React.FC = () => {
  const { t } = useI18n();
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const config = useAgentOrchestrationStore((state) => state.config);
  const isLoading = useAgentOrchestrationStore((state) => state.isLoading);
  const isSavingMode = useAgentOrchestrationStore((state) => state.isSavingMode);
  const error = useAgentOrchestrationStore((state) => state.error);
  const loadConfig = useAgentOrchestrationStore((state) => state.loadConfig);
  const setMode = useAgentOrchestrationStore((state) => state.setMode);
  const setProvider = useAgentOrchestrationStore((state) => state.setProvider);
  const effectiveMode = config?.mode.effective ?? 'native';
  const isProviderConflict = config?.providerState === 'conflict' || effectiveMode === 'conflict';

  React.useEffect(() => {
    void loadConfig({ force: true });
  }, [activeProjectId, loadConfig]);

  const handleProviderSelect = async (selectionId: string) => {
    const activeSelectionId = isProviderConflict ? 'conflict' : (activeProvider ? getProviderSelectionId(activeProvider) : effectiveMode);
    if (selectionId === activeSelectionId) return;
    const result = selectionId.startsWith('provider:')
      ? await setProvider(selectionId.slice('provider:'.length))
      : await setMode(selectionId as Exclude<SlimMode, 'conflict'>);
    if (!result.ok) {
      toast.error(result.conflict ? t('settings.agentOrchestration.toast.openCodeConflict') : result.message || t('settings.agentOrchestration.toast.modeSwitchFailed'));
      return;
    }
    toast.success(t('settings.agentOrchestration.toast.modeUpdated'));
  };

  const providers = (config?.providers ?? []).filter(shouldShowProvider);
  const activeProvider = isProviderConflict ? null : (providers.find((provider) => provider.active) ?? null);
  const activeSelectionId = isProviderConflict ? 'conflict' : (activeProvider ? getProviderSelectionId(activeProvider) : effectiveMode);
  const currentLabel = isProviderConflict ? t('settings.agentOrchestration.badge.conflict') : (activeProvider ? getProviderTitle(activeProvider, t) : effectiveMode);
  const handleConfigureProvider = async () => {
    const surfaceId = activeProvider?.managementSurfaceId;
    if (!surfaceId) return;
    useUIStore.getState().setSettingsPage('plugins');
    const loaded = await usePluginsStore.getState().loadPlugins({ force: true });
    const surfaceExists = usePluginsStore.getState().managementSurfaces.some((surface) => surface.id === surfaceId);
    if (loaded && surfaceExists) {
      usePluginsStore.getState().selectSurface(surfaceId);
      return;
    }
    toast.error(t('settings.plugins.page.empty.select'));
  };

  return (
    <SettingsPageLayout className="max-w-6xl space-y-4">
      <div className="space-y-1">
        <h2 className="typography-ui-header font-semibold text-foreground">{t('settings.page.openagent.title')}</h2>
        <p className="typography-ui text-muted-foreground">{t('settings.agentOrchestration.description')}</p>
      </div>

      <div className="rounded-lg border border-border/70 bg-[var(--surface-elevated)] p-3">
        <div className="grid gap-2 lg:grid-cols-3">
          <ModeButton
            id="native"
            active={effectiveMode === 'native' && !activeProvider && !isProviderConflict}
            current={activeSelectionId}
            title={t('settings.agentOrchestration.mode.native.title')}
            description={t('settings.agentOrchestration.mode.native.description')}
            disabled={isSavingMode}
            onSelect={handleProviderSelect}
          />
          {providers.map((provider) => (
            <ModeButton
              key={provider.id}
              id={getProviderSelectionId(provider)}
              active={provider.active}
              current={activeSelectionId}
              title={getProviderTitle(provider, t)}
              description={getProviderDescription(provider, t)}
              metadata={getProviderMetadata(provider, t)}
              disabled={isSavingMode || (!provider.installed && !provider.remembered && provider.legacyMode == null)}
              onSelect={handleProviderSelect}
            />
          ))}
        </div>
        <div className="mt-3 flex flex-col gap-2 border-t border-border/60 pt-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge className={isProviderConflict ? 'bg-[var(--status-error)]/10 text-[var(--status-error)]' : 'bg-primary/10 text-primary'}>
                {t('settings.agentOrchestration.badge.currentMode', { mode: currentLabel })}
              </Badge>
              {isLoading ? <Badge className="bg-muted text-muted-foreground">{t('settings.agentOrchestration.badge.loading')}</Badge> : null}
            </div>
            <div className="typography-micro text-muted-foreground">
              {t('settings.agentOrchestration.scopeDescription')}
            </div>
            <div className="break-all font-mono typography-micro text-muted-foreground">
              {t('settings.agentOrchestration.openCodeConfigPrefix')}: {config?.mode.configPaths.join(' | ') || t('settings.agentOrchestration.state.notRead')}
            </div>
            {config?.mode.tuiConfigPath ? (
              <div className="break-all font-mono typography-micro text-muted-foreground">{t('settings.agentOrchestration.tuiConfigPrefix')}: {config.mode.tuiConfigPath}</div>
            ) : null}
            {config?.mode.conflicts.map((conflict) => (
              <div key={conflict} className="typography-micro text-[var(--status-error)]">{conflict}</div>
            ))}
            {error ? <div className="typography-micro text-[var(--status-error)]">{error}</div> : null}
          </div>
        </div>
      </div>

      {effectiveMode === 'native' && !activeProvider && !isProviderConflict ? (
        <div className="rounded-lg border border-border/70 bg-background px-4 py-10 text-center">
          <RiSparklingLine className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
          <div className="typography-ui-label font-semibold text-foreground">{t('settings.agentOrchestration.nativeActive.title')}</div>
          <p className="mt-1 typography-ui text-muted-foreground">{t('settings.agentOrchestration.nativeActive.description')}</p>
        </div>
      ) : null}

      {activeProvider ? (
        <div className="rounded-lg border border-border/70 bg-background px-4 py-8 text-center">
          <RiSparklingLine className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
          <div className="typography-ui-label font-semibold text-foreground">{t('settings.agentOrchestration.providerSettings.title', { provider: getProviderTitle(activeProvider, t) })}</div>
          <p className="mx-auto mt-1 max-w-xl typography-ui text-muted-foreground">{t('settings.agentOrchestration.providerSettings.description')}</p>
          <div className="mt-4 flex justify-center">
            <Button type="button" size="sm" variant="outline" onClick={() => void handleConfigureProvider()} disabled={!activeProvider?.managementSurfaceId}>
              {activeProvider.configurable === false ? t('settings.agentOrchestration.providerSettings.viewPluginAction') : t('settings.agentOrchestration.providerSettings.action')}
            </Button>
          </div>
        </div>
      ) : null}
      {isProviderConflict ? (
        <div className="rounded-lg border border-[var(--status-error)]/40 bg-[var(--status-error)]/5 px-4 py-8 text-center typography-ui text-[var(--status-error)]">
          {t('settings.agentOrchestration.conflict.description')}
        </div>
      ) : null}
    </SettingsPageLayout>
  );
};
