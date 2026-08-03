import React from 'react';
import type { JsonValue, RuntimeContextTarget } from '@piarium/protocol';
import {
  SettingsChipGroup,
  SettingsControlGroup,
} from '@/components/sections/shared/SettingsSection';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import {
  PluginBooleanField,
  PluginNumberField,
  PluginOptionalNumberField,
  PluginOptionalSelectField,
  PluginSelectField,
  PluginStringField,
  PluginStringListField,
  PluginTextareaField,
} from './PluginConfigFields';
import { PluginDraftFooter, PluginRuntimeNote } from './PluginSettingsPanelShared';
import {
  hasJsonPath,
  readJsonPath,
  type JsonObject,
} from './plugin-config-model';
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
const SUBGROUP_CLASS = 'border-t border-border/60 pt-5';

const thinkingOptions = MAGIC_CONTEXT_THINKING_LEVELS.map((value) => ({ value, label: value }));

const AdvancedValueNotice: React.FC<{ field: string; configured?: boolean }> = ({
  configured = true,
  field,
}) => {
  const { t } = useI18n();
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2.5">
      <p className="font-mono typography-meta text-foreground">{field}</p>
      <p className="mt-1 typography-meta text-muted-foreground">
        {t(configured
          ? 'settings.piarium.pluginSettings.magic.advancedValue.configured'
          : 'settings.piarium.pluginSettings.magic.advancedValue.available')}
      </p>
    </div>
  );
};

const OverviewPanel: React.FC<PanelProps> = ({ fields, scope }) => {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.magic.core.title')}
        description={t('settings.piarium.pluginSettings.magic.core.description')}
        contentClassName="space-y-4"
      >
        <PluginBooleanField {...fields} path={['enabled']} label="enabled" defaultValue />
        <PluginSelectField
          {...fields}
          path={['transform_mode']}
          label="transform_mode"
          description={t('settings.piarium.pluginSettings.magic.core.transformDescription')}
          defaultValue="ts"
          options={[
            { value: 'ts', label: 'TypeScript' },
            { value: 'rust', label: 'Rust / subc' },
          ]}
        />
        {scope === 'user' ? (
          <PluginStringField
            {...fields}
            path={['language']}
            label="language"
            description={t('settings.piarium.pluginSettings.magic.core.languageDescription')}
            placeholder="en | zh | ja | ..."
          />
        ) : null}
        <PluginBooleanField
          {...fields}
          path={['temporal_awareness']}
          label="temporal_awareness"
          defaultValue
        />
        <PluginNumberField
          {...fields}
          path={['toast_duration_ms']}
          label="toast_duration_ms"
          defaultValue={5000}
          min={0}
          max={60000}
          unit="ms"
        />
      </SettingsControlGroup>

      <SettingsControlGroup
        className={SUBGROUP_CLASS}
        title={t('settings.piarium.pluginSettings.magic.pi.title')}
        description={t('settings.piarium.pluginSettings.magic.pi.description')}
        contentClassName="space-y-4"
      >
        <PluginBooleanField {...fields} path={['todowrite', 'enabled']} label="todowrite.enabled" defaultValue />
        <PluginBooleanField {...fields} path={['todowrite', 'overlay']} label="todowrite.overlay" defaultValue />
        <PluginBooleanField
          {...fields}
          path={['keep_subagents']}
          label="keep_subagents"
          description={t('settings.piarium.pluginSettings.magic.pi.restartRequired')}
          defaultValue={false}
        />
        {scope === 'user' ? (
          <>
            <PluginBooleanField
              {...fields}
              path={['fail_closed_blocking']}
              label="fail_closed_blocking"
              description={t('settings.piarium.pluginSettings.magic.pi.failClosedDescription')}
              defaultValue
            />
            <PluginStringListField
              {...fields}
              path={['pi', 'subagent_extensions']}
              label="pi.subagent_extensions"
              description={t('settings.piarium.pluginSettings.magic.pi.subagentExtensionsDescription')}
              placeholder="extension/path.ts"
              emptyArrayOnClear
            />
          </>
        ) : null}
      </SettingsControlGroup>

      <SettingsControlGroup
        className={SUBGROUP_CLASS}
        title={t('settings.piarium.pluginSettings.magic.mural.title')}
        description={t('settings.piarium.pluginSettings.magic.mural.description')}
        contentClassName="space-y-4"
      >
        <PluginBooleanField
          {...fields}
          path={['experimental', 'mural', 'enabled']}
          label="experimental.mural.enabled"
          defaultValue={false}
        />
        <PluginStringField
          {...fields}
          path={['experimental', 'mural', 'model']}
          label="experimental.mural.model"
          placeholder="provider/model"
        />
      </SettingsControlGroup>
    </div>
  );
};

const PipelinePanel: React.FC<PanelProps> = ({ fields, scope }) => {
  const { t } = useI18n();
  const cacheTtlIsMap = hasObjectValue(fields.draft, ['cache_ttl']);
  const percentageIsMap = hasObjectValue(fields.draft, ['execute_threshold_percentage']);
  const tokenThresholdsConfigured = hasJsonPath(fields.draft, ['execute_threshold_tokens']);
  return (
    <div className="space-y-6">
      {scope === 'project' ? (
        <PluginRuntimeNote>
          {t('settings.piarium.pluginSettings.magic.pipeline.thresholdRaiseOnly')}
        </PluginRuntimeNote>
      ) : null}
      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.magic.pipeline.title')}
        description={t('settings.piarium.pluginSettings.magic.pipeline.description')}
        contentClassName="space-y-4"
      >
        {cacheTtlIsMap ? (
          <AdvancedValueNotice field="cache_ttl" />
        ) : (
          <PluginStringField {...fields} path={['cache_ttl']} label="cache_ttl" defaultValue="5m" placeholder="5m" />
        )}
        {percentageIsMap ? (
          <AdvancedValueNotice field="execute_threshold_percentage" />
        ) : (
          <PluginNumberField
            {...fields}
            path={['execute_threshold_percentage']}
            label="execute_threshold_percentage"
            defaultValue={65}
            min={20}
            max={80}
            unit="%"
          />
        )}
        <AdvancedValueNotice field="execute_threshold_tokens" configured={tokenThresholdsConfigured} />
        <PluginNumberField {...fields} path={['protected_tags']} label="protected_tags" defaultValue={20} min={1} max={100} />
        <PluginNumberField {...fields} path={['clear_reasoning_age']} label="clear_reasoning_age" defaultValue={50} min={10} />
        <PluginNumberField
          {...fields}
          path={['history_budget_percentage']}
          label="history_budget_percentage"
          defaultValue={0.15}
          min={0.05}
          max={0.5}
          step={0.01}
        />
        <PluginNumberField
          {...fields}
          path={['historian_timeout_ms']}
          label="historian_timeout_ms"
          defaultValue={300000}
          min={60000}
          unit="ms"
        />
      </SettingsControlGroup>

      <SettingsControlGroup
        className={SUBGROUP_CLASS}
        title={t('settings.piarium.pluginSettings.magic.pipeline.triggers')}
        contentClassName="space-y-4"
      >
        <PluginBooleanField
          {...fields}
          path={['commit_cluster_trigger', 'enabled']}
          label="commit_cluster_trigger.enabled"
          defaultValue
        />
        <PluginNumberField
          {...fields}
          path={['commit_cluster_trigger', 'min_clusters']}
          label="commit_cluster_trigger.min_clusters"
          defaultValue={3}
          min={1}
        />
        <PluginBooleanField
          {...fields}
          path={['system_prompt_injection', 'enabled']}
          label="system_prompt_injection.enabled"
          defaultValue
        />
        <PluginStringListField
          {...fields}
          path={['system_prompt_injection', 'skip_signatures']}
          label="system_prompt_injection.skip_signatures"
          defaultValue={['<!-- magic-context: skip -->']}
          placeholder="<!-- magic-context: skip -->"
        />
      </SettingsControlGroup>

      <SettingsControlGroup
        className={SUBGROUP_CLASS}
        title={t('settings.piarium.pluginSettings.magic.pipeline.compression')}
        description={t('settings.piarium.pluginSettings.magic.pipeline.compressionDescription')}
        contentClassName="space-y-4"
      >
        <PluginBooleanField
          {...fields}
          path={['smart_drops']}
          label="smart_drops"
          description={t('settings.piarium.pluginSettings.magic.pipeline.smartDropsRestart')}
          defaultValue={false}
        />
        <PluginBooleanField
          {...fields}
          path={['caveman_text_compression', 'enabled']}
          label="caveman_text_compression.enabled"
          defaultValue={false}
        />
        <PluginNumberField
          {...fields}
          path={['caveman_text_compression', 'min_chars']}
          label="caveman_text_compression.min_chars"
          defaultValue={500}
          min={100}
          max={10000}
        />
      </SettingsControlGroup>
    </div>
  );
};

const MemoryPanel: React.FC<PanelProps> = ({ fields }) => {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.magic.memory.title')}
        description={t('settings.piarium.pluginSettings.magic.memory.description')}
        contentClassName="space-y-4"
      >
        <PluginBooleanField {...fields} path={['memory', 'enabled']} label="memory.enabled" defaultValue />
        <PluginNumberField
          {...fields}
          path={['memory', 'injection_budget_tokens']}
          label="memory.injection_budget_tokens"
          defaultValue={4000}
          min={500}
          max={20000}
          unit="tokens"
        />
        <PluginBooleanField {...fields} path={['memory', 'auto_promote']} label="memory.auto_promote" defaultValue />
        <PluginNumberField
          {...fields}
          path={['memory', 'retrieval_count_promotion_threshold']}
          label="memory.retrieval_count_promotion_threshold"
          defaultValue={3}
          min={1}
        />
      </SettingsControlGroup>

      <SettingsControlGroup
        className={SUBGROUP_CLASS}
        title={t('settings.piarium.pluginSettings.magic.memory.autoSearch')}
        contentClassName="space-y-4"
      >
        <PluginBooleanField {...fields} path={['memory', 'auto_search', 'enabled']} label="memory.auto_search.enabled" defaultValue />
        <PluginNumberField
          {...fields}
          path={['memory', 'auto_search', 'score_threshold']}
          label="memory.auto_search.score_threshold"
          defaultValue={0.6}
          min={0.3}
          max={0.95}
          step={0.05}
        />
        <PluginNumberField
          {...fields}
          path={['memory', 'auto_search', 'min_prompt_chars']}
          label="memory.auto_search.min_prompt_chars"
          defaultValue={20}
          min={5}
          max={500}
        />
      </SettingsControlGroup>

      <SettingsControlGroup
        className={SUBGROUP_CLASS}
        title={t('settings.piarium.pluginSettings.magic.memory.gitIndex')}
        contentClassName="space-y-4"
      >
        <PluginBooleanField
          {...fields}
          path={['memory', 'git_commit_indexing', 'enabled']}
          label="memory.git_commit_indexing.enabled"
          defaultValue={false}
        />
        <PluginNumberField
          {...fields}
          path={['memory', 'git_commit_indexing', 'since_days']}
          label="memory.git_commit_indexing.since_days"
          defaultValue={365}
          min={7}
          max={3650}
          unit="days"
        />
        <PluginNumberField
          {...fields}
          path={['memory', 'git_commit_indexing', 'max_commits']}
          label="memory.git_commit_indexing.max_commits"
          defaultValue={2000}
          min={100}
          max={20000}
        />
      </SettingsControlGroup>
    </div>
  );
};

const EmbeddingPanel: React.FC<PanelProps> = ({ fields, scope }) => {
  const { t } = useI18n();
  const providerValue = readJsonPath(fields.draft, ['embedding', 'provider']);
  const provider = typeof providerValue === 'string' ? providerValue : 'local';
  const fallbackValue = readJsonPath(fields.draft, ['embedding', 'fallback_provider']);
  const fallback = typeof fallbackValue === 'string' ? fallbackValue : undefined;
  const remoteShape = provider === 'openai-compatible'
    || (provider === 'synapse' && fallback === 'openai-compatible');
  return (
    <div className="space-y-6">
      {scope === 'project' ? (
        <PluginRuntimeNote>
          {t('settings.piarium.pluginSettings.magic.embedding.projectDescription')}
        </PluginRuntimeNote>
      ) : null}
      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.magic.embedding.title')}
        description={t('settings.piarium.pluginSettings.magic.embedding.description')}
        contentClassName="space-y-4"
      >
        {scope === 'user' ? (
          <PluginSelectField
            {...fields}
            path={['embedding', 'provider']}
            label="embedding.provider"
            defaultValue="local"
            options={[
              { value: 'local', label: 'local' },
              { value: 'openai-compatible', label: 'openai-compatible' },
              { value: 'synapse', label: 'synapse' },
              { value: 'off', label: 'off' },
            ]}
          />
        ) : null}
        {scope === 'user' && provider === 'synapse' ? (
          <PluginOptionalSelectField
            {...fields}
            path={['embedding', 'fallback_provider']}
            label="embedding.fallback_provider"
            options={[
              { value: 'local', label: 'local' },
              { value: 'openai-compatible', label: 'openai-compatible' },
              { value: 'off', label: 'off' },
            ]}
          />
        ) : null}
        <PluginStringField
          {...fields}
          path={['embedding', 'model']}
          label="embedding.model"
          defaultValue={scope === 'user' && provider === 'local' ? 'Xenova/all-MiniLM-L6-v2' : ''}
          placeholder="embedding-model"
        />
        {scope === 'user' && remoteShape ? (
          <PluginStringField
            {...fields}
            path={['embedding', 'endpoint']}
            label="embedding.endpoint"
            placeholder="https://example.com/v1/embeddings"
          />
        ) : null}
        <PluginStringField
          {...fields}
          path={['embedding', 'api_key']}
          label="embedding.api_key"
          description={t(scope === 'user'
            ? 'settings.piarium.pluginSettings.magic.embedding.apiKeyUser'
            : 'settings.piarium.pluginSettings.magic.embedding.apiKeyProject')}
          inputType="password"
          autoComplete="new-password"
          placeholder={scope === 'user' ? '{env:EMBEDDING_API_KEY}' : 'stored in project JSONC'}
        />
      </SettingsControlGroup>

      <SettingsControlGroup
        className={SUBGROUP_CLASS}
        title={t('settings.piarium.pluginSettings.magic.embedding.request')}
        contentClassName="space-y-4"
      >
        <PluginStringField {...fields} path={['embedding', 'input_type']} label="embedding.input_type" placeholder="passage" />
        <PluginStringField {...fields} path={['embedding', 'query_input_type']} label="embedding.query_input_type" placeholder="query" />
        <PluginStringField {...fields} path={['embedding', 'truncate']} label="embedding.truncate" placeholder="NONE | START | END" />
        <PluginOptionalNumberField
          {...fields}
          path={['embedding', 'max_input_tokens']}
          label="embedding.max_input_tokens"
          emptyLabel={t('settings.piarium.pluginSettings.field.pluginDefault')}
          min={1}
          fallbackValue={512}
          unit="tokens"
        />
      </SettingsControlGroup>

      {scope === 'user' ? (
        <SettingsControlGroup
          className={SUBGROUP_CLASS}
          title={t('settings.piarium.pluginSettings.magic.embedding.storage')}
          contentClassName="space-y-4"
        >
          <PluginNumberField {...fields} path={['sqlite', 'cache_size_mb']} label="sqlite.cache_size_mb" defaultValue={64} min={2} max={2048} unit="MiB" />
          <PluginNumberField {...fields} path={['sqlite', 'mmap_size_mb']} label="sqlite.mmap_size_mb" defaultValue={0} min={0} max={8192} unit="MiB" />
          <PluginStringField {...fields} path={['subc', 'connection_file']} label="subc.connection_file" placeholder="~/.config/subc/connection.json" />
          <PluginBooleanField {...fields} path={['shadow_embedding', 'enabled']} label="shadow_embedding.enabled" defaultValue={false} />
        </SettingsControlGroup>
      ) : null}
    </div>
  );
};

const AgentsPanel: React.FC<PanelProps> = ({ fields, scope }) => {
  const { t } = useI18n();
  const [agent, setAgent] = React.useState<MagicContextAgent>('historian');
  const historianProject = scope === 'project' && agent === 'historian';
  const pluginDefault = t('settings.piarium.pluginSettings.field.pluginDefault');
  return (
    <div className="space-y-6">
      {scope === 'project' ? (
        <PluginRuntimeNote>
          {t('settings.piarium.pluginSettings.magic.agents.projectSecurity')}
        </PluginRuntimeNote>
      ) : null}
      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.magic.agents.title')}
        description={t(`settings.piarium.pluginSettings.magic.agent.${agent}.description`)}
        contentClassName="space-y-4"
      >
        <div className="flex justify-end">
          <Select value={agent} disabled={fields.disabled} onValueChange={setAgent}>
            <SelectTrigger size="settings" className="min-w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {MAGIC_CONTEXT_AGENTS.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <PluginBooleanField {...fields} path={[agent, 'disable']} label={`${agent}.disable`} defaultValue={false} />
        {!historianProject ? (
          <PluginStringField {...fields} path={[agent, 'model']} label={`${agent}.model`} placeholder="provider/model" />
        ) : null}
        {!historianProject ? (
          <PluginStringListField {...fields} path={[agent, 'fallback_models']} label={`${agent}.fallback_models`} placeholder="provider/model" />
        ) : null}
        <PluginOptionalSelectField
          {...fields}
          path={[agent, 'thinking_level']}
          label={`${agent}.thinking_level`}
          options={thinkingOptions}
        />
        <PluginOptionalNumberField {...fields} path={[agent, 'temperature']} label={`${agent}.temperature`} emptyLabel={pluginDefault} min={0} max={2} step={0.1} fallbackValue={0} />
        <PluginOptionalNumberField {...fields} path={[agent, 'top_p']} label={`${agent}.top_p`} emptyLabel={pluginDefault} min={0} max={1} step={0.05} fallbackValue={1} />
        <PluginOptionalNumberField {...fields} path={[agent, 'maxTokens']} label={`${agent}.maxTokens`} emptyLabel={pluginDefault} fallbackValue={1} />
        <PluginOptionalNumberField {...fields} path={[agent, 'maxSteps']} label={`${agent}.maxSteps`} emptyLabel={pluginDefault} fallbackValue={1} />
        <PluginStringField {...fields} path={[agent, 'description']} label={`${agent}.description`} />
        <PluginOptionalSelectField
          {...fields}
          path={[agent, 'mode']}
          label={`${agent}.mode`}
          options={[
            { value: 'subagent', label: 'subagent' },
            { value: 'primary', label: 'primary' },
            { value: 'all', label: 'all' },
          ]}
        />
        <PluginStringField {...fields} path={[agent, 'color']} label={`${agent}.color`} placeholder="#a1b2c3" />
        {agent === 'historian' ? (
          <PluginBooleanField {...fields} path={['historian', 'two_pass']} label="historian.two_pass" defaultValue={false} />
        ) : null}
        {agent === 'dreamer' ? (
          <PluginBooleanField {...fields} path={['dreamer', 'inject_docs']} label="dreamer.inject_docs" defaultValue />
        ) : null}
        {agent === 'sidekick' ? (
          <PluginNumberField {...fields} path={['sidekick', 'timeout_ms']} label="sidekick.timeout_ms" defaultValue={30000} unit="ms" />
        ) : null}
      </SettingsControlGroup>

      {scope === 'user' ? (
        <SettingsControlGroup
          className={SUBGROUP_CLASS}
          title={t('settings.piarium.pluginSettings.magic.agents.instructions')}
          description={t('settings.piarium.pluginSettings.magic.agents.instructionsDescription')}
          contentClassName="space-y-4"
        >
          <PluginTextareaField {...fields} path={[agent, 'prompt']} label={`${agent}.prompt`} />
          {agent === 'sidekick' ? (
            <PluginTextareaField {...fields} path={['sidekick', 'system_prompt']} label="sidekick.system_prompt" />
          ) : null}
          <AdvancedValueNotice field={`${agent}.tools / ${agent}.permission`} configured={(
            hasJsonPath(fields.draft, [agent, 'tools']) || hasJsonPath(fields.draft, [agent, 'permission'])
          )} />
        </SettingsControlGroup>
      ) : null}
    </div>
  );
};

const TasksPanel: React.FC<PanelProps> = ({ fields }) => {
  const { t } = useI18n();
  const [task, setTask] = React.useState<MagicContextDreamerTask>('map-memories');
  const defaults = MAGIC_CONTEXT_DREAMER_TASK_DEFAULTS[task];
  const promotionThreshold = 'promotionThreshold' in defaults ? defaults.promotionThreshold : undefined;
  return (
    <SettingsControlGroup
      title={t('settings.piarium.pluginSettings.magic.tasks.title')}
      description={t('settings.piarium.pluginSettings.magic.tasks.description')}
      contentClassName="space-y-4"
    >
      <div className="flex justify-end">
        <Select value={task} disabled={fields.disabled} onValueChange={setTask}>
          <SelectTrigger size="settings" className="min-w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {(Object.keys(MAGIC_CONTEXT_DREAMER_TASK_DEFAULTS) as MagicContextDreamerTask[]).map((name) => (
              <SelectItem key={name} value={name}>{name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <PluginStringField
        {...fields}
        path={['dreamer', 'tasks', task, 'schedule']}
        label="schedule"
        description={t('settings.piarium.pluginSettings.magic.tasks.schedule.description')}
        defaultValue={defaults.schedule}
        allowEmpty
        placeholder="0 3 * * *"
      />
      <PluginStringField {...fields} path={['dreamer', 'tasks', task, 'model']} label="model" placeholder="provider/model" />
      <PluginStringListField {...fields} path={['dreamer', 'tasks', task, 'fallback_models']} label="fallback_models" placeholder="provider/model" />
      <PluginOptionalSelectField
        {...fields}
        path={['dreamer', 'tasks', task, 'thinking_level']}
        label="thinking_level"
        options={thinkingOptions}
      />
      <PluginNumberField
        {...fields}
        path={['dreamer', 'tasks', task, 'timeout_minutes']}
        label="timeout_minutes"
        defaultValue={defaults.timeout}
        min={5}
        unit="min"
      />
      {promotionThreshold !== undefined ? (
        <PluginNumberField
          {...fields}
          path={['dreamer', 'tasks', task, 'promotion_threshold']}
          label="promotion_threshold"
          description={t('settings.piarium.pluginSettings.magic.tasks.promotionDescription')}
          defaultValue={promotionThreshold}
          min={2}
          max={20}
        />
      ) : null}
    </SettingsControlGroup>
  );
};

function issueMessage(issue: MagicContextDraftIssue, t: ReturnType<typeof useI18n>['t']): string {
  switch (issue.code) {
    case 'embedding-required':
      return t('settings.piarium.pluginSettings.magic.validation.embeddingRequired', { field: issue.field });
    case 'invalid-color':
      return t('settings.piarium.pluginSettings.magic.validation.invalidColor', { field: issue.field });
    case 'invalid-language':
      return t('settings.piarium.pluginSettings.magic.validation.invalidLanguage');
    case 'invalid-schedule':
      return t('settings.piarium.pluginSettings.magic.validation.invalidSchedule', { field: issue.field });
    case 'invalid-value':
      return t('settings.piarium.pluginSettings.magic.validation.invalidValue', { field: issue.field });
    case 'required':
      return t('settings.piarium.pluginSettings.magic.validation.required', { field: issue.field });
  }
}

export const MagicContextSettings: React.FC<MagicContextSettingsProps> = ({
  initialPanel = 'overview',
  runtimeTarget,
  targetKey,
}) => {
  const { t } = useI18n();
  const [scope, setScope] = React.useState<MagicContextScope>('user');
  const [panel, setPanel] = React.useState<MagicContextPanel>(initialPanel);
  const userController = useTextObjectDraft({
    format: 'jsonc',
    paths: MAGIC_USER_PATHS,
    root: 'user-config',
    runtimeTarget,
    targetKey,
  });
  const projectController = useTextObjectDraft({
    format: 'jsonc',
    paths: MAGIC_PROJECT_PATHS,
    root: 'project',
    runtimeTarget,
    targetKey,
  });
  const controller = scope === 'user' ? userController : projectController;
  const trustBlocked = scope === 'project' && !controller.projectTrusted;
  const issue = React.useMemo(
    () => magicContextDraftIssue(controller.draft, scope),
    [controller.draft, scope],
  );
  const ignoredProjectPaths = React.useMemo(
    () => scope === 'project' ? magicContextProjectIgnoredPaths(controller.draft) : [],
    [controller.draft, scope],
  );
  const fields: MagicFields = {
    disabled: !controller.loaded || controller.loading || controller.saving || trustBlocked,
    draft: controller.draft,
    onRemove: controller.removeValue,
    onSet: controller.setValue,
  };
  const panelOptions = MAGIC_CONTEXT_PANELS.map((value) => ({
    value,
    label: t(`settings.piarium.pluginSettings.magic.panel.${value}`),
  }));

  return (
    <div className="space-y-7">
      <PluginRuntimeNote>{t('settings.piarium.pluginSettings.magic.runtimeNote')}</PluginRuntimeNote>

      <MagicContextRuntimePanel runtimeTarget={runtimeTarget} />

      <div className="flex flex-col gap-4 rounded-lg border border-border/60 px-4 py-4">
        <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
          <div className="space-y-1">
            <h3 className="typography-settings-group-title text-foreground">
              {t('settings.piarium.pluginSettings.magic.workspace.title')}
            </h3>
            <p className="typography-meta text-muted-foreground">
              {t('settings.piarium.pluginSettings.magic.workspace.description')}
            </p>
          </div>
          <Select
            value={scope}
            disabled={userController.saving || projectController.saving}
            onValueChange={setScope}
          >
            <SelectTrigger size="settings" className="min-w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="user">
                {t('settings.piarium.pluginSettings.magic.scope.user')}{userController.dirty ? ' •' : ''}
              </SelectItem>
              <SelectItem value="project">
                {t('settings.common.scope.project')}{projectController.dirty ? ' •' : ''}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <SettingsChipGroup
          value={panel}
          options={panelOptions}
          onChange={setPanel}
          aria-label={t('settings.piarium.pluginSettings.magic.workspace.navigation')}
        />
      </div>

      {scope === 'project' ? (
        <PluginRuntimeNote>{t('settings.piarium.pluginSettings.magic.projectBoundary')}</PluginRuntimeNote>
      ) : null}
      {ignoredProjectPaths.length > 0 ? (
        <PluginRuntimeNote>
          {t('settings.piarium.pluginSettings.magic.projectIgnored', {
            fields: ignoredProjectPaths.join(', '),
          })}
        </PluginRuntimeNote>
      ) : null}

      {panel === 'overview' ? <OverviewPanel fields={fields} scope={scope} /> : null}
      {panel === 'pipeline' ? <PipelinePanel fields={fields} scope={scope} /> : null}
      {panel === 'memory' ? <MemoryPanel fields={fields} scope={scope} /> : null}
      {panel === 'embedding' ? <EmbeddingPanel fields={fields} scope={scope} /> : null}
      {panel === 'agents' ? <AgentsPanel fields={fields} scope={scope} /> : null}
      {panel === 'tasks' ? <TasksPanel fields={fields} scope={scope} /> : null}

      <PluginDraftFooter
        controller={controller}
        blocked={trustBlocked || issue !== null}
        blockedMessage={trustBlocked || !issue ? undefined : issueMessage(issue, t)}
      />
    </div>
  );
};
