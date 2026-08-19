import React from 'react';
import type { JsonValue, PiConfigScope, RuntimeContextTarget } from '@piarium/protocol';
import {
  SettingsControlGroup,
  SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import {
  PluginOptionalBooleanField,
  PluginOptionalNumberField,
  PluginOptionalSelectField,
  PluginStringField,
} from './PluginConfigFields';
import { PluginAdvancedDraftEditor } from './PluginAdvancedDraftEditor';
import {
  PluginConfigSource,
  PluginDraftFooter,
  PluginRuntimeNote,
  ScopeSelector,
} from './PluginSettingsPanelShared';
import {
  AFT_EDIT_MODES,
  AFT_PYTHON_LSP,
  AFT_SEMANTIC_BACKENDS,
  AFT_TOOL_SURFACES,
  AFT_VALIDATION_MODES,
  AFT_WARNING_DELIVERY,
  aftBashDraftMode,
  aftDraftIssues,
  type AftDraftIssue,
} from './aft-config-model';
import { AftRuntimePanel } from './AftRuntimePanel';
import { useTextObjectDraft, type PluginObjectDraft } from './usePluginConfigDraft';

interface AftSettingsProps {
  runtimeTarget: RuntimeContextTarget;
  targetKey: string;
}

interface AftFields {
  disabled: boolean;
  draft: Record<string, JsonValue>;
  onRemove: PluginObjectDraft['removeValue'];
  onSet: PluginObjectDraft['setValue'];
}

const GROUP_CLASS = 'border-t border-border/60 pt-5';

const fieldProps = (
  controller: PluginObjectDraft,
  blocked: boolean,
): AftFields => ({
  disabled: !controller.loaded
    || controller.loading
    || controller.saving
    || controller.rawError !== null
    || blocked,
  draft: controller.draft,
  onRemove: controller.removeValue,
  onSet: controller.setValue,
});

const AftIssueNote: React.FC<{ issues: readonly AftDraftIssue[] }> = ({ issues }) => {
  const { t } = useI18n();
  if (issues.length === 0) return null;
  return (
    <div className="space-y-1 rounded-md border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/5 px-3 py-2 typography-meta text-[var(--status-warning)]">
      {issues.map((issue) => (
        <p key={`${issue.code}:${issue.field}`}>
          {issue.code === 'ignored-project'
            ? t('settings.piarium.pluginSettings.aft.diagnostic.ignoredProject', { field: issue.field })
            : issue.code === 'unknown-field'
              ? t('settings.piarium.pluginSettings.aft.diagnostic.unknownField', { field: issue.field })
              : issue.code === 'invalid-boolean'
                ? t('settings.piarium.pluginSettings.validation.invalidBoolean', { field: issue.field })
                : issue.code === 'invalid-number'
                  ? t('settings.piarium.pluginSettings.validation.invalidNumber', { field: issue.field })
                  : t('settings.piarium.pluginSettings.validation.invalidValue', { field: issue.field })}
        </p>
      ))}
    </div>
  );
};

const CoreQuickSettings: React.FC<{ fields: AftFields }> = ({ fields }) => {
  const { t } = useI18n();
  const notSet = t('settings.piarium.pluginSettings.field.notSet');
  const keyedOptions = (values: readonly string[]) => values.map((value) => ({
    value,
    label: t(`settings.piarium.pluginSettings.aft.value.${value}` as never),
  }));
  return (
    <SettingsControlGroup
      title={t('settings.piarium.pluginSettings.aft.section.core')}
      contentClassName="space-y-4"
    >
      <PluginOptionalBooleanField {...fields} path={['enabled']} label={t('settings.piarium.pluginSettings.aft.field.enabled')} unsetLabel={notSet} />
      <PluginOptionalSelectField {...fields} path={['tool_surface']} label={t('settings.piarium.pluginSettings.aft.field.toolSurface')} options={keyedOptions(AFT_TOOL_SURFACES)} unsetLabel={notSet} />
      <PluginOptionalSelectField {...fields} path={['edit_mode']} label={t('settings.piarium.pluginSettings.aft.field.editMode')} options={keyedOptions(AFT_EDIT_MODES)} unsetLabel={notSet} />
      <PluginOptionalBooleanField {...fields} path={['format_on_edit']} label={t('settings.piarium.pluginSettings.aft.field.formatOnEdit')} unsetLabel={notSet} />
      <PluginOptionalSelectField {...fields} path={['validate_on_edit']} label={t('settings.piarium.pluginSettings.aft.field.validateOnEdit')} options={keyedOptions(AFT_VALIDATION_MODES)} unsetLabel={notSet} />
      <PluginOptionalSelectField {...fields} path={['configure_warnings_delivery']} label={t('settings.piarium.pluginSettings.aft.field.warningDelivery')} options={keyedOptions(AFT_WARNING_DELIVERY)} unsetLabel={notSet} />
    </SettingsControlGroup>
  );
};

const FeatureQuickSettings: React.FC<{ fields: AftFields }> = ({ fields }) => {
  const { t } = useI18n();
  const notSet = t('settings.piarium.pluginSettings.field.notSet');
  const bashMode = aftBashDraftMode(fields.draft);
  return (
    <SettingsControlGroup className={GROUP_CLASS} title={t('settings.piarium.pluginSettings.aft.section.features')} contentClassName="space-y-4">
      <PluginOptionalBooleanField {...fields} path={['search_index']} label={t('settings.piarium.pluginSettings.aft.field.searchIndex')} unsetLabel={notSet} />
      <PluginOptionalBooleanField {...fields} path={['semantic_search']} label={t('settings.piarium.pluginSettings.aft.field.semanticSearch')} unsetLabel={notSet} />
      <PluginOptionalBooleanField {...fields} path={['callgraph_store']} label={t('settings.piarium.pluginSettings.aft.field.callgraphStore')} unsetLabel={notSet} />
      <PluginOptionalBooleanField {...fields} path={['inspect', 'enabled']} label={t('settings.piarium.pluginSettings.aft.field.inspectEnabled')} unsetLabel={notSet} />
      <PluginOptionalSelectField
        {...fields}
        path={['bash']}
        label={t('settings.piarium.pluginSettings.aft.field.bash')}
        options={[
          { value: true, label: t('settings.piarium.pluginSettings.field.enabled') },
          { value: false, label: t('settings.piarium.pluginSettings.field.disabled') },
        ]}
        preserveUnsupportedUntilSelection
        unsupportedLabel={t('settings.piarium.pluginSettings.aft.value.custom')}
        unsetLabel={notSet}
      />
      {bashMode === 'custom' ? (
        <PluginRuntimeNote>{t('settings.piarium.pluginSettings.aft.bashCustomNote')}</PluginRuntimeNote>
      ) : null}
    </SettingsControlGroup>
  );
};

const LspQuickSettings: React.FC<{ fields: AftFields; userScope: boolean }> = ({ fields, userScope }) => {
  const { t } = useI18n();
  const notSet = t('settings.piarium.pluginSettings.field.notSet');
  return (
    <SettingsControlGroup className={GROUP_CLASS} title={t('settings.piarium.pluginSettings.aft.section.lsp')} contentClassName="space-y-4">
      <PluginOptionalSelectField
        {...fields}
        path={['lsp', 'python']}
        label={t('settings.piarium.pluginSettings.aft.field.lspPython')}
        options={AFT_PYTHON_LSP.map((value) => ({
          value,
          label: value === 'auto'
            ? t('settings.piarium.pluginSettings.aft.value.auto')
            : value === 'pyright' ? 'Pyright' : 'ty',
        }))}
        unsetLabel={notSet}
      />
      <PluginOptionalBooleanField {...fields} path={['lsp', 'diagnostics_on_edit']} label={t('settings.piarium.pluginSettings.aft.field.diagnosticsOnEdit')} unsetLabel={notSet} />
      {userScope ? (
        <>
          <PluginOptionalBooleanField {...fields} path={['lsp', 'auto_install']} label={t('settings.piarium.pluginSettings.aft.field.autoInstall')} unsetLabel={notSet} />
          <PluginOptionalNumberField {...fields} path={['lsp', 'grace_days']} label={t('settings.piarium.pluginSettings.aft.field.graceDays')} min={1} step={1} unsetLabel={notSet} />
        </>
      ) : null}
    </SettingsControlGroup>
  );
};

const SemanticQuickSettings: React.FC<{ fields: AftFields; userScope: boolean }> = ({ fields, userScope }) => {
  const { t } = useI18n();
  const notSet = t('settings.piarium.pluginSettings.field.notSet');
  return (
    <SettingsControlGroup className={GROUP_CLASS} title={t('settings.piarium.pluginSettings.aft.section.semantic')} contentClassName="space-y-4">
      {userScope ? (
        <PluginOptionalSelectField
          {...fields}
          path={['semantic', 'backend']}
          label={t('settings.piarium.pluginSettings.aft.field.semanticBackend')}
          options={AFT_SEMANTIC_BACKENDS.map((value) => ({ value, label: value }))}
          unsetLabel={notSet}
        />
      ) : null}
      <PluginStringField {...fields} path={['semantic', 'model']} label={t('settings.piarium.pluginSettings.aft.field.semanticModel')} />
      <PluginOptionalNumberField {...fields} path={['semantic', 'timeout_ms']} label={t('settings.piarium.pluginSettings.aft.field.semanticTimeout')} min={1} step={1} unit="ms" unsetLabel={notSet} />
      {userScope ? (
        <PluginOptionalNumberField {...fields} path={['semantic', 'query_timeout_ms']} label={t('settings.piarium.pluginSettings.aft.field.semanticQueryTimeout')} min={1} step={1} unit="ms" unsetLabel={notSet} />
      ) : null}
      <PluginOptionalNumberField {...fields} path={['semantic', 'max_batch_size']} label={t('settings.piarium.pluginSettings.aft.field.semanticMaxBatch')} min={1} step={1} unsetLabel={notSet} />
      <PluginOptionalNumberField {...fields} path={['semantic', 'max_files']} label={t('settings.piarium.pluginSettings.aft.field.semanticMaxFiles')} min={1} step={1} unsetLabel={notSet} />
    </SettingsControlGroup>
  );
};

const UserSafetyQuickSettings: React.FC<{ fields: AftFields }> = ({ fields }) => {
  const { t } = useI18n();
  const notSet = t('settings.piarium.pluginSettings.field.notSet');
  return (
    <SettingsControlGroup className={GROUP_CLASS} title={t('settings.piarium.pluginSettings.aft.section.safety')} contentClassName="space-y-4">
      <PluginOptionalBooleanField {...fields} path={['restrict_to_project_root']} label={t('settings.piarium.pluginSettings.aft.field.restrictRoot')} unsetLabel={notSet} />
      <PluginOptionalBooleanField {...fields} path={['backup', 'enabled']} label={t('settings.piarium.pluginSettings.aft.field.backupEnabled')} unsetLabel={notSet} />
      <PluginOptionalNumberField {...fields} path={['backup', 'max_depth']} label={t('settings.piarium.pluginSettings.aft.field.backupDepth')} min={1} step={1} unsetLabel={notSet} />
      <PluginOptionalNumberField {...fields} path={['backup', 'max_file_size']} label={t('settings.piarium.pluginSettings.aft.field.backupSize')} min={1} step={1} unit="B" unsetLabel={notSet} />
      <PluginOptionalBooleanField {...fields} path={['sandbox', 'enabled']} label={t('settings.piarium.pluginSettings.aft.field.sandboxEnabled')} unsetLabel={notSet} />
    </SettingsControlGroup>
  );
};

export const AftSettings: React.FC<AftSettingsProps> = ({ runtimeTarget, targetKey }) => {
  const { t } = useI18n();
  const [scope, setScope] = React.useState<PiConfigScope>('global');
  const userController = useTextObjectDraft({
    authority: 'aft-user',
    format: 'jsonc',
    runtimeTarget,
    targetKey: `${targetKey}:user`,
  });
  const projectController = useTextObjectDraft({
    format: 'jsonc',
    paths: ['.cortexkit/aft.jsonc'],
    root: 'project',
    runtimeTarget,
    targetKey: `${targetKey}:project`,
  });
  const controller = scope === 'project' ? projectController : userController;
  const trustBlocked = scope === 'project' && !controller.projectTrusted;
  const issues = React.useMemo(() => aftDraftIssues(controller.draft, scope), [controller.draft, scope]);
  const blockingIssue = issues.find((candidate) => candidate.blocking);
  const validationBlocked = blockingIssue !== undefined;
  const fields = fieldProps(controller, trustBlocked || validationBlocked);

  return (
    <div className="space-y-7">
      <SettingsFieldRow label={t('settings.piarium.pluginSettings.scope.label')} info={t('settings.piarium.pluginSettings.scope.description')} controlClassName="w-full max-w-[24rem]">
        <ScopeSelector
          value={scope}
          onChange={setScope}
          disabled={userController.saving || projectController.saving}
        />
      </SettingsFieldRow>
      <PluginConfigSource controller={controller} />
      <PluginRuntimeNote>
        {scope === 'project'
          ? t('settings.piarium.pluginSettings.aft.authority.project')
          : t('settings.piarium.pluginSettings.aft.authority.user')}
      </PluginRuntimeNote>
      {scope === 'project' ? (
        <PluginRuntimeNote>{t('settings.piarium.pluginSettings.aft.projectScopeNote')}</PluginRuntimeNote>
      ) : null}
      <AftIssueNote issues={issues} />
      <CoreQuickSettings fields={fields} />
      <FeatureQuickSettings fields={fields} />
      <LspQuickSettings fields={fields} userScope={scope === 'global'} />
      <SemanticQuickSettings fields={fields} userScope={scope === 'global'} />
      {scope === 'global' ? <UserSafetyQuickSettings fields={fields} /> : null}
      <PluginAdvancedDraftEditor controller={controller} blocked={trustBlocked} />
      <PluginDraftFooter
        controller={controller}
        blocked={trustBlocked || validationBlocked}
        blockedMessage={trustBlocked
          ? undefined
          : validationBlocked
            ? t('settings.piarium.pluginSettings.aft.validation.fixBeforeSave')
            : undefined}
      />
      <AftRuntimePanel runtimeTarget={runtimeTarget} targetKey={targetKey} />
    </div>
  );
};
