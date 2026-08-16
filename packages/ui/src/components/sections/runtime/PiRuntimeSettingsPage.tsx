import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_HELPER_CLASS,
  SettingsFieldRow,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { usePiRuntimeSnapshot } from '@/hooks/usePiRuntimeSnapshot';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { piRuntimeSourceLabelKey } from '@/lib/pi-runtime/source-label';

const statusKey = (status: string) => {
  switch (status) {
    case 'ready':
      return 'settings.runtime.status.ready' as const;
    case 'missing':
      return 'settings.runtime.status.missing' as const;
    case 'upgrade-required':
      return 'settings.runtime.status.upgradeRequired' as const;
    case 'failed':
      return 'settings.runtime.status.failed' as const;
    case 'installing':
      return 'onboarding.localSetup.status.installing' as const;
    case 'upgrading':
      return 'onboarding.localSetup.status.upgrading' as const;
    case 'probing':
      return 'onboarding.localSetup.status.probing' as const;
    default:
      return 'settings.runtime.status.discovering' as const;
  }
};

export function PiRuntimeSettingsPage() {
  const { t } = useI18n();
  const { piRuntime } = useRuntimeAPIs();
  const { snapshot } = usePiRuntimeSnapshot();
  const [customPath, setCustomPath] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const current = snapshot.active
    ?? snapshot.installations.find((entry) => entry.id === 'system' || entry.id === 'standalone');
  const busyStatus = snapshot.status === 'installing'
    || snapshot.status === 'upgrading'
    || snapshot.status === 'discovering'
    || snapshot.status === 'probing'
    || busy;

  const run = React.useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <SettingsPageLayout
      title={t('settings.page.runtime.title')}
      description={t('settings.page.runtime.description')}
    >
      <SettingsSection
        title={t('settings.runtime.section.current')}
        divider={false}
        info={t('settings.runtime.info.current')}
        settingsItem="runtime.current"
      >
        <div className={SETTINGS_FIELDS_STACK_CLASS}>
          <SettingsFieldRow label={t('settings.runtime.field.status')} settingsItem="runtime.status">
            <span className={SETTINGS_HELPER_CLASS}>{t(statusKey(snapshot.status))}</span>
          </SettingsFieldRow>
          <SettingsFieldRow label={t('settings.runtime.field.version')} settingsItem="runtime.version">
            <span className="font-mono typography-meta text-foreground">{current?.version ?? '—'}</span>
          </SettingsFieldRow>
          <SettingsFieldRow label={t('settings.runtime.field.source')} settingsItem="runtime.source">
            <span className="font-mono typography-meta text-foreground">
              {current ? t(piRuntimeSourceLabelKey(current.source)) : '—'}
            </span>
          </SettingsFieldRow>
          <SettingsFieldRow label={t('settings.runtime.field.commandPath')} settingsItem="runtime.commandPath">
            <span className="break-all font-mono typography-meta text-foreground">{current?.commandPath ?? '—'}</span>
          </SettingsFieldRow>
          <SettingsFieldRow label={t('settings.runtime.field.nodePath')} settingsItem="runtime.nodePath">
            <span className="break-all font-mono typography-meta text-foreground">{current?.nodePath ?? '—'}</span>
          </SettingsFieldRow>
          <SettingsFieldRow label={t('settings.runtime.field.packageRoot')} settingsItem="runtime.packageRoot">
            <span className="break-all font-mono typography-meta text-foreground">{current?.packageRoot ?? '—'}</span>
          </SettingsFieldRow>
        </div>
        {snapshot.issue ? (
          <p className="mt-4 typography-meta text-destructive">{snapshot.issue}</p>
        ) : null}
      </SettingsSection>

      <SettingsSection title={t('settings.runtime.section.actions')} settingsItem="runtime.actions">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busyStatus || !piRuntime}
            onClick={() => void run(() => piRuntime!.refresh())}
          >
            {t('settings.runtime.actions.rediscover')}
          </Button>
          {piRuntime?.capabilities.install && (snapshot.status === 'missing' || snapshot.installPlan?.action === 'install') ? (
            <Button type="button" disabled={busyStatus} onClick={() => void run(() => piRuntime.install())}>
              {t('settings.runtime.actions.install')}
            </Button>
          ) : null}
          {piRuntime?.capabilities.install && (snapshot.status === 'upgrade-required' || snapshot.installPlan?.action === 'upgrade') ? (
            <Button type="button" disabled={busyStatus} onClick={() => void run(() => piRuntime.upgrade())}>
              {t('settings.runtime.actions.upgrade')}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            disabled={busyStatus || !piRuntime}
            onClick={() => void run(async () => {
              const packageRoot = piRuntime!.capabilities.pickPackageRoot
                ? await piRuntime!.pickPackageRoot()
                : customPath.trim();
              if (packageRoot) await piRuntime!.activateCustom(packageRoot);
            })}
          >
            {t('settings.runtime.actions.selectOther')}
          </Button>
          {current?.packageRoot && piRuntime?.capabilities.openLocation ? (
            <Button
              type="button"
              variant="outline"
              disabled={busyStatus}
              onClick={() => void run(() => piRuntime.openLocation(current.packageRoot!))}
            >
              {t('settings.runtime.actions.openLocation')}
            </Button>
          ) : null}
        </div>
        {!piRuntime?.capabilities.pickPackageRoot ? (
          <div className="mt-4">
            <SettingsFieldRow label={t('onboarding.localSetup.customPath.placeholder')}>
              <Input
                value={customPath}
                onChange={(event) => setCustomPath(event.target.value)}
                placeholder={t('onboarding.localSetup.customPath.placeholder')}
              />
            </SettingsFieldRow>
          </div>
        ) : null}
      </SettingsSection>
    </SettingsPageLayout>
  );
}
