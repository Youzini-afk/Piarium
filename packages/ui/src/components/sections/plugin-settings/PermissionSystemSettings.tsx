import React from 'react';
import type { JsonValue, PiConfigScope, RuntimeContextTarget } from '@piarium/protocol';
import {
  SettingsControlGroup,
  SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';
import { useI18n, type I18nKey } from '@/lib/i18n';
import {
  PluginOptionalBooleanField,
  PluginOptionalNumberField,
  PluginOptionalSelectField,
} from './PluginConfigFields';
import { PluginAdvancedDraftEditor } from './PluginAdvancedDraftEditor';
import {
  PluginConfigSource,
  PluginDraftFooter,
  ScopeSelector,
} from './PluginSettingsPanelShared';
import {
  permissionSystemDraftIssues,
  type PermissionSystemDraftIssue,
} from './permission-system-config-model';
import { PermissionSystemRuntimePanel } from './PermissionSystemRuntimePanel';
import { useTextObjectDraft, type PluginObjectDraft } from './usePluginConfigDraft';

interface PermissionSystemSettingsProps {
  runtimeTarget: RuntimeContextTarget;
  targetKey: string;
}

interface PermissionSystemFields {
  disabled: boolean;
  draft: Record<string, JsonValue>;
  onRemove: PluginObjectDraft['removeValue'];
  onSet: PluginObjectDraft['setValue'];
}

const GROUP_CLASS = 'border-t border-border/60 pt-5';
const POLICY_SURFACES = [
  '*',
  'read',
  'write',
  'edit',
  'bash',
  'mcp',
  'skill',
  'path',
  'path_read',
  'path_write',
  'external_directory',
  'external_directory_read',
  'external_directory_write',
] as const;

const FIELD_LABEL_KEYS: Readonly<Record<string, I18nKey>> = {
  '$schema': 'settings.piarium.pluginSettings.permissionSystem.field.schema',
  authorizerChain: 'settings.piarium.pluginSettings.permissionSystem.field.authorizerChain',
  debugLog: 'settings.piarium.pluginSettings.permissionSystem.field.debugLog',
  doublePressToConfirm: 'settings.piarium.pluginSettings.permissionSystem.field.doublePressToConfirm',
  forwardingTimeoutMs: 'settings.piarium.pluginSettings.permissionSystem.field.forwardingTimeout',
  permission: 'settings.piarium.pluginSettings.permissionSystem.field.permissionPolicy',
  'permission.*': 'settings.piarium.pluginSettings.permissionSystem.policy.fallback',
  'permission.read': 'settings.piarium.pluginSettings.permissionSystem.policy.read',
  'permission.write': 'settings.piarium.pluginSettings.permissionSystem.policy.write',
  'permission.edit': 'settings.piarium.pluginSettings.permissionSystem.policy.edit',
  'permission.bash': 'settings.piarium.pluginSettings.permissionSystem.policy.bash',
  'permission.mcp': 'settings.piarium.pluginSettings.permissionSystem.policy.mcp',
  'permission.skill': 'settings.piarium.pluginSettings.permissionSystem.policy.skill',
  'permission.path': 'settings.piarium.pluginSettings.permissionSystem.policy.path',
  'permission.external_directory': 'settings.piarium.pluginSettings.permissionSystem.policy.externalDirectory',
  permissionReviewLog: 'settings.piarium.pluginSettings.permissionSystem.field.permissionReviewLog',
  piInfrastructureReadPaths: 'settings.piarium.pluginSettings.permissionSystem.field.infrastructureReadPaths',
  promptFieldMaxWidth: 'settings.piarium.pluginSettings.permissionSystem.field.promptFieldMaxWidth',
  promptMaxRows: 'settings.piarium.pluginSettings.permissionSystem.field.promptMaxRows',
  reviewLogFieldMaxWidth: 'settings.piarium.pluginSettings.permissionSystem.field.reviewLogFieldMaxWidth',
  shellTools: 'settings.piarium.pluginSettings.permissionSystem.field.shellTools',
  toolInputPreviewMaxLength: 'settings.piarium.pluginSettings.permissionSystem.field.deprecatedCaps',
  toolTextSummaryMaxLength: 'settings.piarium.pluginSettings.permissionSystem.field.deprecatedCaps',
  yoloMode: 'settings.piarium.pluginSettings.permissionSystem.field.yoloMode',
};

const policyLabelKey = (surface: typeof POLICY_SURFACES[number]): I18nKey => (
  FIELD_LABEL_KEYS[`permission.${surface}`]
  ?? 'settings.piarium.pluginSettings.permissionSystem.field.permissionPolicy'
);

const policyLabel = (
  surface: typeof POLICY_SURFACES[number],
  t: ReturnType<typeof useI18n>['t'],
): string => {
  if (surface === 'path_read') {
    return `${t('settings.piarium.pluginSettings.permissionSystem.policy.path')} · ${t('settings.piarium.pluginSettings.permissionSystem.policy.read')}`;
  }
  if (surface === 'path_write') {
    return `${t('settings.piarium.pluginSettings.permissionSystem.policy.path')} · ${t('settings.piarium.pluginSettings.permissionSystem.policy.write')}`;
  }
  if (surface === 'external_directory_read') {
    return `${t('settings.piarium.pluginSettings.permissionSystem.policy.externalDirectory')} · ${t('settings.piarium.pluginSettings.permissionSystem.policy.read')}`;
  }
  if (surface === 'external_directory_write') {
    return `${t('settings.piarium.pluginSettings.permissionSystem.policy.externalDirectory')} · ${t('settings.piarium.pluginSettings.permissionSystem.policy.write')}`;
  }
  return t(policyLabelKey(surface));
};

const issueLabelKey = (field: string): I18nKey => {
  if (FIELD_LABEL_KEYS[field]) return FIELD_LABEL_KEYS[field];
  if (field.startsWith('permission.')) {
    return 'settings.piarium.pluginSettings.permissionSystem.field.permissionPolicy';
  }
  if (field.startsWith('shellTools.')) {
    return 'settings.piarium.pluginSettings.permissionSystem.field.shellTools';
  }
  return 'settings.piarium.pluginSettings.permissionSystem.field.configuration';
};

const fieldProps = (
  controller: PluginObjectDraft,
  trustBlocked: boolean,
): PermissionSystemFields => ({
  disabled: !controller.loaded
    || controller.loading
    || controller.saving
    || controller.rawError !== null
    || trustBlocked,
  draft: controller.draft,
  onRemove: controller.removeValue,
  onSet: controller.setValue,
});

const ValidationNote: React.FC<{
  issues: readonly PermissionSystemDraftIssue[];
}> = ({ issues }) => {
  const { t } = useI18n();
  if (issues.length === 0) return null;
  return (
    <div className="space-y-1 rounded-md border border-[var(--status-error)]/30 bg-[var(--status-error)]/5 px-3 py-2 typography-meta text-[var(--status-error)]">
      {issues.map((issue) => {
        const message = issue.code === 'trailing-comma'
          ? t('settings.piarium.pluginSettings.permissionSystem.validation.trailingComma')
          : issue.code === 'invalid-number'
            ? t('settings.piarium.pluginSettings.validation.invalidNumber', {
                field: t(issueLabelKey(issue.field)),
              })
            : issue.code === 'invalid-boolean'
              ? t('settings.piarium.pluginSettings.validation.invalidBoolean', {
                  field: t(issueLabelKey(issue.field)),
                })
              : t('settings.piarium.pluginSettings.validation.invalidValue', {
                  field: t(issueLabelKey(issue.field)),
                });
        return <p key={`${issue.code}:${issue.field}`}>{message}</p>;
      })}
    </div>
  );
};

const QuickSettings: React.FC<{
  fields: PermissionSystemFields;
}> = ({ fields }) => {
  const { t } = useI18n();
  const notSet = t('settings.piarium.pluginSettings.field.notSet');
  const actionOptions = (['allow', 'ask', 'deny'] as const).map((value) => ({
    value,
    label: t(`settings.common.permission.${value}` as I18nKey),
  }));
  const customRules = t('settings.piarium.pluginSettings.permissionSystem.policy.customRules');

  return (
    <div className="space-y-7">
      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.permissionSystem.section.policy')}
        contentClassName="space-y-4"
      >
        {POLICY_SURFACES.map((surface) => (
          <PluginOptionalSelectField
            key={surface}
            {...fields}
            path={['permission', surface]}
            label={policyLabel(surface, t)}
            options={actionOptions}
            preserveUnsupportedUntilSelection
            unsetLabel={notSet}
            unsupportedLabel={customRules}
          />
        ))}
      </SettingsControlGroup>

      <SettingsControlGroup
        className={GROUP_CLASS}
        title={t('settings.piarium.pluginSettings.permissionSystem.section.runtime')}
        contentClassName="space-y-4"
      >
        <PluginOptionalBooleanField {...fields} path={['yoloMode']} label={t('settings.piarium.pluginSettings.permissionSystem.field.yoloMode')} unsetLabel={notSet} />
        {fields.draft.yoloMode === true ? (
          <p className="rounded-md border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/5 px-3 py-2 typography-meta text-[var(--status-warning)]">
            {t('settings.piarium.pluginSettings.permissionSystem.warning.yoloMode')}
          </p>
        ) : null}
        <PluginOptionalBooleanField {...fields} path={['permissionReviewLog']} label={t('settings.piarium.pluginSettings.permissionSystem.field.permissionReviewLog')} unsetLabel={notSet} />
        <PluginOptionalBooleanField {...fields} path={['debugLog']} label={t('settings.piarium.pluginSettings.permissionSystem.field.debugLog')} unsetLabel={notSet} />
        <PluginOptionalBooleanField {...fields} path={['doublePressToConfirm']} label={t('settings.piarium.pluginSettings.permissionSystem.field.doublePressToConfirm')} unsetLabel={notSet} />
      </SettingsControlGroup>

      <SettingsControlGroup
        className={GROUP_CLASS}
        title={t('settings.piarium.pluginSettings.permissionSystem.section.prompting')}
        contentClassName="space-y-4"
      >
        <PluginOptionalNumberField {...fields} path={['forwardingTimeoutMs']} label={t('settings.piarium.pluginSettings.permissionSystem.field.forwardingTimeout')} min={1} step={1} unit="ms" unsetLabel={notSet} />
        <PluginOptionalNumberField {...fields} path={['promptMaxRows']} label={t('settings.piarium.pluginSettings.permissionSystem.field.promptMaxRows')} min={1} step={1} unsetLabel={notSet} />
        <PluginOptionalNumberField {...fields} path={['promptFieldMaxWidth']} label={t('settings.piarium.pluginSettings.permissionSystem.field.promptFieldMaxWidth')} min={1} step={1} unsetLabel={notSet} />
        <PluginOptionalNumberField {...fields} path={['reviewLogFieldMaxWidth']} label={t('settings.piarium.pluginSettings.permissionSystem.field.reviewLogFieldMaxWidth')} min={1} step={1} unsetLabel={notSet} />
      </SettingsControlGroup>
    </div>
  );
};

export const PermissionSystemSettings: React.FC<PermissionSystemSettingsProps> = ({
  runtimeTarget,
  targetKey,
}) => {
  const { t } = useI18n();
  const [scope, setScope] = React.useState<PiConfigScope>('global');
  const globalController = useTextObjectDraft({
    format: 'jsonc',
    paths: ['extensions/pi-permission-system/config.json'],
    root: 'agent',
    runtimeTarget,
    targetKey: `${targetKey}:global`,
  });
  const projectController = useTextObjectDraft({
    format: 'jsonc',
    paths: ['.pi/extensions/pi-permission-system/config.json'],
    root: 'project',
    runtimeTarget,
    targetKey: `${targetKey}:project`,
  });
  const controller = scope === 'project' ? projectController : globalController;
  const trustBlocked = scope === 'project' && !controller.projectTrusted;
  const issues = React.useMemo(
    () => permissionSystemDraftIssues(controller.draft, controller.rawContent),
    [controller.draft, controller.rawContent],
  );
  const fields = fieldProps(controller, trustBlocked);
  const blockingIssue = issues[0];

  return (
    <div className="space-y-7">
      <SettingsFieldRow
        label={t('settings.piarium.pluginSettings.scope.label')}
        info={t('settings.piarium.pluginSettings.scope.description')}
        controlClassName="w-full max-w-[24rem]"
      >
        <ScopeSelector
          value={scope}
          onChange={setScope}
          disabled={globalController.saving || projectController.saving}
        />
      </SettingsFieldRow>
      <PluginConfigSource controller={controller} />
      <ValidationNote issues={issues} />
      <QuickSettings fields={fields} />
      <PluginAdvancedDraftEditor controller={controller} blocked={trustBlocked} />
      <PluginDraftFooter
        controller={controller}
        blocked={trustBlocked || blockingIssue !== undefined}
        blockedMessage={blockingIssue
          ? blockingIssue.code === 'trailing-comma'
            ? t('settings.piarium.pluginSettings.permissionSystem.validation.trailingComma')
            : t('settings.piarium.pluginSettings.permissionSystem.validation.fixBeforeSave')
          : undefined}
      />
      <PermissionSystemRuntimePanel runtimeTarget={runtimeTarget} targetKey={targetKey} />
    </div>
  );
};
