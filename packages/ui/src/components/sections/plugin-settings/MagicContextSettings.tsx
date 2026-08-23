import React from 'react';
import type { JsonValue, RuntimeContextTarget } from '@piarium/protocol';
import {
  SettingsControlGroup,
  SettingsFieldRow,
  SettingsChipGroup,
} from '@/components/sections/shared/SettingsSection';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import {
  PluginBooleanField,
  PluginNumberField,
  PluginOptionalSelectField,
  PluginSelectField,
  PluginStringField,
  PluginStringListField,
} from './PluginConfigFields';
import { PluginAdvancedDraftEditor } from './PluginAdvancedDraftEditor';
import {
  PluginConfigSource,
  PluginDraftFooter,
  PluginRuntimeNote,
} from './PluginSettingsPanelShared';
import { hasJsonPath, readJsonPath, type JsonObject } from './plugin-config-model';
import {
  hasObjectValue,
  MAGIC_CONTEXT_AGENTS,
  MAGIC_CONTEXT_DREAMER_TASK_DEFAULTS,
  MAGIC_CONTEXT_PANELS,
  MAGIC_CONTEXT_THINKING_LEVELS,
  magicContextDraftIssue,
  magicContextProjectIgnoredPaths,
  type MagicContextAgent,
  type MagicContextDraftIssue,
  type MagicContextDreamerTask,
  type MagicContextPanel,
  type MagicContextScope,
} from './magic-context-config-model';
import { useTextObjectDraft } from './usePluginConfigDraft';
import { MagicContextRuntimePanel } from './MagicContextRuntimePanel';

interface MagicContextSettingsProps {
  initialPanel?: MagicContextPanel;
  runtimeTarget: RuntimeContextTarget;
  targetKey: string;
}

interface MagicFields {
  disabled: boolean;
  draft: JsonObject;
  onRemove: (path: readonly string[]) => void;
  onSet: (path: readonly string[], value: JsonValue) => void;
}

interface PanelProps {
  fields: MagicFields;
  scope: MagicContextScope;
}

const MAGIC_USER_PATHS = ['cortexkit/magic-context.jsonc', 'cortexkit/magic-context.json'] as const;
const MAGIC_PROJECT_PATHS = ['.cortexkit/magic-context.jsonc', '.cortexkit/magic-context.json'] as const;

/** These keys are intentionally kept in one namespace so locale dictionaries can add them atomically. */
const magicUi = (
  t: ReturnType<typeof useI18n>['t'],
  key: string,
  params?: I18nParams,
): string => t(key as I18nKey, params);

const thinkingOptions = (t: ReturnType<typeof useI18n>['t']) => MAGIC_CONTEXT_THINKING_LEVELS.map((value) => ({
  value,
  label: magicUi(t, `settings.piarium.pluginSettings.magic.ui.thinking.${value}`),
}));

/** A map must never be rendered as a scalar fallback: doing so would destroy model overrides. */
const AdvancedMapNotice: React.FC<{ labelKey: string }> = ({ labelKey }) => {
  const { t } = useI18n();
  return (
    <PluginRuntimeNote>
      <span className="font-medium text-foreground">{magicUi(t, labelKey)}: {magicUi(t, 'settings.piarium.pluginSettings.magic.ui.perModelRules')}</span>{' '}
      {t('settings.piarium.pluginSettings.magic.advancedValue.configured')}
    </PluginRuntimeNote>
  );
};

const ContextPanel: React.FC<PanelProps> = ({ fields, scope }) => {
  const { t } = useI18n();
  const cacheTtlIsMap = hasObjectValue(fields.draft, ['cache_ttl']);
  const percentageIsMap = hasObjectValue(fields.draft, ['execute_threshold_percentage']);
  const tokenThresholdsConfigured = hasJsonPath(fields.draft, ['execute_threshold_tokens']);
  return (
    <div className="space-y-7">
      {scope === 'project' ? (
        <PluginRuntimeNote>{t('settings.piarium.pluginSettings.magic.pipeline.thresholdRaiseOnly')}</PluginRuntimeNote>
      ) : null}
      <SettingsControlGroup
        title={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.contextBehavior')}
        info={t('settings.piarium.pluginSettings.magic.core.description')}
        contentClassName="space-y-4"
      >
        <PluginBooleanField {...fields} path={['enabled']} label={t('settings.piarium.pluginSettings.field.enabled')} defaultValue />
        <PluginSelectField
          {...fields}
          path={['transform_mode']}
          label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.transform')}
          info={t('settings.piarium.pluginSettings.magic.core.transformDescription')}
          defaultValue="ts"
          options={[
            { value: 'ts', label: magicUi(t, 'settings.piarium.pluginSettings.magic.ui.transformTypeScript') },
            { value: 'rust', label: magicUi(t, 'settings.piarium.pluginSettings.magic.ui.transformRust') },
          ]}
        />
        {scope === 'user' ? (
          <PluginBooleanField
            {...fields}
            path={['fail_closed_blocking']}
            label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.failClosed')}
            info={t('settings.piarium.pluginSettings.magic.pi.failClosedDescription')}
            defaultValue
          />
        ) : null}
        {cacheTtlIsMap ? (
          <AdvancedMapNotice labelKey="settings.piarium.pluginSettings.magic.ui.contextCacheTtl" />
        ) : (
          <PluginStringField {...fields} path={['cache_ttl']} label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.contextCacheTtl')} defaultValue="5m" placeholder="5m" />
        )}
        {percentageIsMap ? (
          <AdvancedMapNotice labelKey="settings.piarium.pluginSettings.magic.ui.executionThreshold" />
        ) : (
          <PluginNumberField
            {...fields}
            path={['execute_threshold_percentage']}
            label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.executionThreshold')}
            defaultValue={65}
            min={20}
            max={80}
            unit="%"
          />
        )}
        {tokenThresholdsConfigured ? (
          <AdvancedMapNotice labelKey="settings.piarium.pluginSettings.magic.ui.tokenThresholds" />
        ) : null}
        <PluginNumberField
          {...fields}
          path={['history_budget_percentage']}
          label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.historyBudget')}
          info={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.historyBudgetInfo')}
          defaultValue={0.15}
          min={0.05}
          max={0.5}
          step={0.01}
        />
      </SettingsControlGroup>

      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.magic.pi.title')}
        info={t('settings.piarium.pluginSettings.magic.pi.description')}
        contentClassName="space-y-4"
      >
        <PluginBooleanField {...fields} path={['todowrite', 'enabled']} label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.todoEnabled')} defaultValue />
        <PluginBooleanField {...fields} path={['todowrite', 'overlay']} label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.todoOverlay')} defaultValue />
        <PluginBooleanField {...fields} path={['mural', 'enabled']} label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.muralEnabled')} defaultValue={false} />
        <PluginStringField {...fields} path={['mural', 'model']} label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.muralModel')} placeholder="provider/model" />
      </SettingsControlGroup>

      <SettingsControlGroup
        title={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.safetyCompression')}
        info={t('settings.piarium.pluginSettings.magic.pipeline.compressionDescription')}
        contentClassName="space-y-4"
      >
        <PluginBooleanField
          {...fields}
          path={['smart_drops']}
          label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.smartDrops')}
          info={t('settings.piarium.pluginSettings.magic.pipeline.smartDropsRestart')}
          defaultValue={false}
        />
        <PluginBooleanField
          {...fields}
          path={['caveman_text_compression', 'enabled']}
          label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.lossyCompression')}
          defaultValue={false}
        />
        <PluginBooleanField {...fields} path={['temporal_awareness']} label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.temporalAwareness')} defaultValue />
      </SettingsControlGroup>
    </div>
  );
};

const EmbeddingFields: React.FC<PanelProps> = ({ fields, scope }) => {
  const { t } = useI18n();
  const providerValue = readJsonPath(fields.draft, ['embedding', 'provider']);
  const provider = typeof providerValue === 'string' ? providerValue : 'local';
  const fallbackValue = readJsonPath(fields.draft, ['embedding', 'fallback_provider']);
  const fallback = typeof fallbackValue === 'string' ? fallbackValue : undefined;
  const remoteShape = provider === 'openai-compatible'
    || (provider === 'synapse' && fallback === 'openai-compatible');
  return (
    <SettingsControlGroup
      title={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.embeddingProvider')}
      info={t('settings.piarium.pluginSettings.magic.embedding.description')}
      contentClassName="space-y-4"
    >
      {scope === 'user' ? (
        <PluginSelectField
          {...fields}
          path={['embedding', 'provider']}
          label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.provider')}
          defaultValue="local"
          options={[
            { value: 'local', label: magicUi(t, 'settings.piarium.pluginSettings.magic.ui.providerLocal') },
            { value: 'openai-compatible', label: magicUi(t, 'settings.piarium.pluginSettings.magic.ui.providerOpenAiCompatible') },
            { value: 'synapse', label: magicUi(t, 'settings.piarium.pluginSettings.magic.ui.providerSynapse') },
            { value: 'off', label: magicUi(t, 'settings.piarium.pluginSettings.magic.ui.providerOff') },
          ]}
        />
      ) : null}
      {scope === 'user' && provider === 'synapse' ? (
        <PluginOptionalSelectField
          {...fields}
          path={['embedding', 'fallback_provider']}
          label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.fallbackProvider')}
          options={[
            { value: 'local', label: magicUi(t, 'settings.piarium.pluginSettings.magic.ui.providerLocal') },
            { value: 'openai-compatible', label: magicUi(t, 'settings.piarium.pluginSettings.magic.ui.providerOpenAiCompatible') },
            { value: 'off', label: magicUi(t, 'settings.piarium.pluginSettings.magic.ui.providerOff') },
          ]}
        />
      ) : null}
      <PluginStringField {...fields} path={['embedding', 'model']} label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.embeddingModel')} placeholder="embedding-model" />
      {scope === 'user' && remoteShape ? (
        <PluginStringField
          {...fields}
          path={['embedding', 'endpoint']}
          label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.embeddingEndpoint')}
          placeholder="https://example.com/v1/embeddings"
        />
      ) : null}
      <PluginStringField
        {...fields}
        path={['embedding', 'api_key']}
        label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.embeddingApiKey')}
        info={t(scope === 'user'
          ? 'settings.piarium.pluginSettings.magic.embedding.apiKeyUser'
          : 'settings.piarium.pluginSettings.magic.embedding.apiKeyProject')}
        inputType="password"
        autoComplete="new-password"
        placeholder={scope === 'user' ? '{env:EMBEDDING_API_KEY}' : undefined}
      />
    </SettingsControlGroup>
  );
};

const MemoryPanel: React.FC<PanelProps> = ({ fields, scope }) => {
  const { t } = useI18n();
  return (
    <div className="space-y-7">
      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.magic.memory.title')}
        info={t('settings.piarium.pluginSettings.magic.memory.description')}
        contentClassName="space-y-4"
      >
        <PluginBooleanField {...fields} path={['memory', 'enabled']} label={t('settings.piarium.pluginSettings.field.enabled')} defaultValue />
        <PluginNumberField
          {...fields}
          path={['memory', 'injection_budget_tokens']}
          label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.memoryBudget')}
          defaultValue={4000}
          min={500}
          max={20000}
          unit="tokens"
        />
        <PluginBooleanField {...fields} path={['memory', 'auto_search', 'enabled']} label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.automaticSearch')} defaultValue />
        <PluginBooleanField {...fields} path={['memory', 'auto_promote']} label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.automaticPromotion')} defaultValue />
        <PluginNumberField
          {...fields}
          path={['memory', 'retrieval_count_promotion_threshold']}
          label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.promotionEvidenceThreshold')}
          defaultValue={3}
          min={1}
        />
      </SettingsControlGroup>

      <EmbeddingFields fields={fields} scope={scope} />

      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.magic.memory.gitIndex')}
        info={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.gitIndexingInfo')}
        contentClassName="space-y-4"
      >
        <PluginBooleanField {...fields} path={['memory', 'git_commit_indexing', 'enabled']} label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.gitIndexing')} defaultValue={false} />
        <PluginNumberField {...fields} path={['memory', 'git_commit_indexing', 'since_days']} label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.commitHistoryWindow')} defaultValue={365} min={7} max={3650} unit="days" />
        <PluginNumberField {...fields} path={['memory', 'git_commit_indexing', 'max_commits']} label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.maximumCommits')} defaultValue={2000} min={100} max={20000} />
      </SettingsControlGroup>
    </div>
  );
};

const AgentPanel: React.FC<PanelProps> = ({ fields, scope }) => {
  const { t } = useI18n();
  const [agent, setAgent] = React.useState<MagicContextAgent>('historian');
  const historianProject = scope === 'project' && agent === 'historian';
  const timeoutPath = agent === 'historian'
    ? ['historian_timeout_ms']
    : agent === 'sidekick' ? ['sidekick', 'timeout_ms'] : null;
  return (
    <div className="space-y-7">
      {scope === 'project' ? (
        <PluginRuntimeNote>{t('settings.piarium.pluginSettings.magic.agents.projectSecurity')}</PluginRuntimeNote>
      ) : null}
      <SettingsControlGroup
        title={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.models')}
        info={t(`settings.piarium.pluginSettings.magic.agent.${agent}.description`)}
        contentClassName="space-y-4"
      >
        <SettingsFieldRow label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.agent')}>
          <Select value={agent} disabled={fields.disabled} onValueChange={(value) => setAgent(value as MagicContextAgent)}>
            <SelectTrigger size="settings" className="w-full min-w-40 max-w-48">
              <SelectValue>{magicUi(t, `settings.piarium.pluginSettings.magic.ui.agent.${agent}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent align="end">
              {MAGIC_CONTEXT_AGENTS.map((name) => (
                <SelectItem key={name} value={name}>{magicUi(t, `settings.piarium.pluginSettings.magic.ui.agent.${name}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsFieldRow>
        <PluginBooleanField
          {...fields}
          path={[agent, 'disable']}
          label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.disabled')}
          info={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.disabledAgentInfo')}
          defaultValue={false}
        />
        {!historianProject ? (
          <PluginStringField {...fields} path={[agent, 'model']} label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.primaryModel')} placeholder="provider/model" />
        ) : null}
        {!historianProject ? (
          <PluginStringListField {...fields} path={[agent, 'fallback_models']} label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.fallbackModels')} placeholder="provider/model" />
        ) : null}
        <PluginOptionalSelectField {...fields} path={[agent, 'thinking_level']} label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.thinkingLevel')} options={thinkingOptions(t)} />
        {timeoutPath ? (
          <PluginNumberField
            {...fields}
            path={timeoutPath}
            label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.timeout')}
            defaultValue={agent === 'sidekick' ? 30000 : 300000}
            min={agent === 'sidekick' ? 1000 : 60000}
            unit="ms"
          />
        ) : null}
      </SettingsControlGroup>
    </div>
  );
};

const MaintenancePanel: React.FC<PanelProps> = ({ fields }) => {
  const { t } = useI18n();
  const [task, setTask] = React.useState<MagicContextDreamerTask>('map-memories');
  const defaults = MAGIC_CONTEXT_DREAMER_TASK_DEFAULTS[task];
  const promotionThreshold = 'promotionThreshold' in defaults ? defaults.promotionThreshold : undefined;
  return (
    <SettingsControlGroup
      title={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.maintenanceSchedules')}
      info={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.maintenanceSchedulesInfo')}
      contentClassName="space-y-4"
    >
      <SettingsFieldRow label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.maintenanceTask')}>
        <Select value={task} disabled={fields.disabled} onValueChange={(value) => setTask(value as MagicContextDreamerTask)}>
          <SelectTrigger size="settings" className="w-full min-w-40 max-w-64">
            <SelectValue>{magicUi(t, `settings.piarium.pluginSettings.magic.ui.task.${task}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent align="end">
            {(Object.keys(MAGIC_CONTEXT_DREAMER_TASK_DEFAULTS) as MagicContextDreamerTask[]).map((name) => (
              <SelectItem key={name} value={name}>{magicUi(t, `settings.piarium.pluginSettings.magic.ui.task.${name}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsFieldRow>
      <PluginStringField
        {...fields}
        path={['dreamer', 'tasks', task, 'schedule']}
        label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.schedule')}
        info={t('settings.piarium.pluginSettings.magic.tasks.schedule.description')}
        defaultValue={defaults.schedule}
        allowEmpty
        placeholder="0 3 * * *"
      />
      <PluginStringField {...fields} path={['dreamer', 'tasks', task, 'model']} label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.dreamerModel')} placeholder="provider/model" />
      <PluginStringListField {...fields} path={['dreamer', 'tasks', task, 'fallback_models']} label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.fallbackModels')} placeholder="provider/model" />
      <PluginOptionalSelectField {...fields} path={['dreamer', 'tasks', task, 'thinking_level']} label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.thinkingLevel')} options={thinkingOptions(t)} />
      <PluginNumberField {...fields} path={['dreamer', 'tasks', task, 'timeout_minutes']} label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.timeout')} defaultValue={defaults.timeout} min={5} unit="min" />
      {promotionThreshold !== undefined ? (
        <PluginNumberField
          {...fields}
          path={['dreamer', 'tasks', task, 'promotion_threshold']}
          label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.promotionThreshold')}
          info={t('settings.piarium.pluginSettings.magic.tasks.promotionDescription')}
          defaultValue={promotionThreshold}
          min={2}
          max={20}
        />
      ) : null}
    </SettingsControlGroup>
  );
};

const issueFieldLabel = (t: ReturnType<typeof useI18n>['t'], field: string): string => {
  if (field === 'embedding.endpoint') return magicUi(t, 'settings.piarium.pluginSettings.magic.ui.embeddingEndpoint');
  if (field === 'embedding.model') return magicUi(t, 'settings.piarium.pluginSettings.magic.ui.embeddingModel');
  if (field === 'language') return magicUi(t, 'settings.piarium.pluginSettings.magic.ui.language');
  if (field.endsWith('.schedule')) return magicUi(t, 'settings.piarium.pluginSettings.magic.ui.schedule');
  if (field.endsWith('.color')) return magicUi(t, 'settings.piarium.pluginSettings.magic.ui.agentColor');
  if (field === 'cache_ttl') return magicUi(t, 'settings.piarium.pluginSettings.magic.ui.contextCacheTtl');
  if (field === 'execute_threshold_percentage') return magicUi(t, 'settings.piarium.pluginSettings.magic.ui.executionThreshold');
  if (field === 'execute_threshold_tokens') return magicUi(t, 'settings.piarium.pluginSettings.magic.ui.tokenThresholds');
  if (field.endsWith('.fallback_models')) return magicUi(t, 'settings.piarium.pluginSettings.magic.ui.fallbackModels');
  if (field.endsWith('.thinking_level')) return magicUi(t, 'settings.piarium.pluginSettings.magic.ui.thinkingLevel');
  if (field.endsWith('.timeout_minutes') || field.endsWith('.timeout_ms')) return magicUi(t, 'settings.piarium.pluginSettings.magic.ui.timeout');
  if (field === 'embedding.provider') return magicUi(t, 'settings.piarium.pluginSettings.magic.ui.embeddingProvider');
  if (field === 'embedding.fallback_provider') return magicUi(t, 'settings.piarium.pluginSettings.magic.ui.fallbackProvider');
  if (field === 'embedding.max_input_tokens') return magicUi(t, 'settings.piarium.pluginSettings.magic.ui.embeddingInputLimit');
  if (field === 'subc.connection_file') return magicUi(t, 'settings.piarium.pluginSettings.magic.ui.subcConnection');
  if (field.startsWith('dreamer.tasks.')) return magicUi(t, 'settings.piarium.pluginSettings.magic.ui.maintenanceTaskSetting');
  if (field.startsWith('historian.') || field.startsWith('dreamer.') || field.startsWith('sidekick.')) return magicUi(t, 'settings.piarium.pluginSettings.magic.ui.agentSetting');
  return magicUi(t, 'settings.piarium.pluginSettings.magic.ui.configurationValue');
};

function issueMessage(issue: MagicContextDraftIssue, t: ReturnType<typeof useI18n>['t']): string {
  const field = issueFieldLabel(t, issue.field);
  switch (issue.code) {
    case 'embedding-required':
      return t('settings.piarium.pluginSettings.magic.validation.embeddingRequired', { field });
    case 'invalid-color':
      return t('settings.piarium.pluginSettings.magic.validation.invalidColor', { field });
    case 'invalid-language':
      return t('settings.piarium.pluginSettings.magic.validation.invalidLanguage');
    case 'invalid-schedule':
      return t('settings.piarium.pluginSettings.magic.validation.invalidSchedule', { field });
    case 'invalid-value':
      return t('settings.piarium.pluginSettings.magic.validation.invalidValue', { field });
    case 'required':
      return t('settings.piarium.pluginSettings.magic.validation.required', { field });
  }
}

const ignoredFieldLabel = (t: ReturnType<typeof useI18n>['t'], path: string): string => {
  const key = ({
    language: 'language',
    'pi.subagent_extensions': 'piChildExtensions',
    'embedding.provider': 'embeddingProvider',
    'embedding.endpoint': 'embeddingEndpoint',
    'embedding.fallback_provider': 'fallbackProvider',
    'historian.model': 'historianModel',
    'historian.fallback_models': 'historianFallbackModels',
    'fail_closed_blocking': 'failClosed',
    auto_update: 'automaticUpdates',
    sqlite: 'sqliteTuning',
    subc: 'subcConnection',
    shadow_embedding: 'shadowEmbedding',
    'historian.prompt': 'historianInstructions',
    'historian.permission': 'historianPermissions',
    'historian.tools': 'historianTools',
    'historian.system_prompt': 'historianSystemInstructions',
    'dreamer.prompt': 'dreamerInstructions',
    'dreamer.permission': 'dreamerPermissions',
    'dreamer.tools': 'dreamerTools',
    'dreamer.system_prompt': 'dreamerSystemInstructions',
    'sidekick.prompt': 'sidekickInstructions',
    'sidekick.permission': 'sidekickPermissions',
    'sidekick.tools': 'sidekickTools',
    'sidekick.system_prompt': 'sidekickSystemInstructions',
  } as Record<string, string | undefined>)[path];
  return magicUi(t, `settings.piarium.pluginSettings.magic.ui.ignored.${key ?? 'pluginOwnedField'}`);
};

export const MagicContextSettings: React.FC<MagicContextSettingsProps> = ({
  initialPanel = 'context',
  runtimeTarget,
  targetKey,
}) => {
  const { t } = useI18n();
  const [scope, setScope] = React.useState<MagicContextScope>('user');
  const initialArea = initialPanel === 'agents'
    ? 'models'
    : initialPanel === 'tasks'
      ? 'maintenance'
      : initialPanel === 'overview' || initialPanel === 'pipeline'
        ? 'context'
        : initialPanel === 'embedding' ? 'memory' : initialPanel;
  const [panel, setPanel] = React.useState<MagicContextPanel>(initialArea);
  const userController = useTextObjectDraft({ format: 'jsonc', paths: MAGIC_USER_PATHS, root: 'user-config', runtimeTarget, targetKey });
  const projectController = useTextObjectDraft({ format: 'jsonc', paths: MAGIC_PROJECT_PATHS, root: 'project', runtimeTarget, targetKey });
  const controller = scope === 'user' ? userController : projectController;
  const trustBlocked = scope === 'project' && !controller.projectTrusted;
  const issue = React.useMemo(() => magicContextDraftIssue(controller.draft, scope), [controller.draft, scope]);
  const ignoredProjectPaths = React.useMemo(
    () => scope === 'project' ? magicContextProjectIgnoredPaths(controller.draft) : [],
    [controller.draft, scope],
  );
  const fields: MagicFields = {
    disabled: !controller.loaded || controller.loading || controller.saving || controller.rawError !== null || trustBlocked,
    draft: controller.draft,
    onRemove: controller.removeValue,
    onSet: controller.setValue,
  };
  const panelOptions = MAGIC_CONTEXT_PANELS.map((value) => ({
    value,
    label: magicUi(t, `settings.piarium.pluginSettings.magic.ui.area.${value}`),
  }));

  return (
    <div className="space-y-7">
      <PluginRuntimeNote>{t('settings.piarium.pluginSettings.magic.runtimeNote')}</PluginRuntimeNote>

      <SettingsFieldRow
        label={t('settings.piarium.pluginSettings.scope.label')}
        info={t('settings.piarium.pluginSettings.scope.description')}
        controlClassName="w-full max-w-[24rem]"
      >
        <Select value={scope} disabled={userController.saving || projectController.saving} onValueChange={setScope}>
          <SelectTrigger size="settings" className="w-full min-w-40 max-w-48">
            <SelectValue>
              {scope === 'user'
                ? t('settings.piarium.pluginSettings.magic.scope.user')
                : t('settings.common.scope.project')}
            </SelectValue>
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="user">{t('settings.piarium.pluginSettings.magic.scope.user')}{userController.dirty ? ' •' : ''}</SelectItem>
            <SelectItem value="project">{t('settings.common.scope.project')}{projectController.dirty ? ' •' : ''}</SelectItem>
          </SelectContent>
        </Select>
      </SettingsFieldRow>
      <PluginConfigSource controller={controller} />
      {controller.rawError ? (
        <PluginRuntimeNote>
          <span className="text-[var(--status-error)]">
            {t('settings.piarium.recovery.pluginSettings.invalidJson')}
          </span>
        </PluginRuntimeNote>
      ) : null}
      <SettingsChipGroup
        value={panel}
        options={panelOptions}
        onChange={setPanel}
        aria-label={magicUi(t, 'settings.piarium.pluginSettings.magic.ui.configurationArea')}
      />

      {scope === 'project' ? <PluginRuntimeNote>{t('settings.piarium.pluginSettings.magic.projectBoundary')}</PluginRuntimeNote> : null}
      {ignoredProjectPaths.length > 0 ? (
        <PluginRuntimeNote>
          {t('settings.piarium.pluginSettings.magic.projectIgnored', {
            fields: ignoredProjectPaths.map((path) => ignoredFieldLabel(t, path)).join(', '),
          })}
        </PluginRuntimeNote>
      ) : null}

      {panel === 'context' ? <ContextPanel fields={fields} scope={scope} /> : null}
      {panel === 'memory' ? <MemoryPanel fields={fields} scope={scope} /> : null}
      {panel === 'models' ? <AgentPanel fields={fields} scope={scope} /> : null}
      {panel === 'maintenance' ? <MaintenancePanel fields={fields} scope={scope} /> : null}

      <PluginAdvancedDraftEditor controller={controller} blocked={trustBlocked} />
      <PluginDraftFooter
        controller={controller}
        blocked={trustBlocked || issue !== null}
        blockedMessage={trustBlocked || !issue ? undefined : issueMessage(issue, t)}
      />

      <MagicContextRuntimePanel runtimeTarget={runtimeTarget} />
    </div>
  );
};
