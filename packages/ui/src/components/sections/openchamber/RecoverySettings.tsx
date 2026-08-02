import React from 'react';
import type { PackageDescriptor, RecoveryPreference } from '@piarium/protocol';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import {
  SettingsRadioGroup,
  SettingsRadioOption,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { updateDesktopSettings } from '@/lib/persistence';
import { getRuntimeKey } from '@/lib/runtime-switch';
import {
  installPiPackage,
  findPiPackage,
  listPiPackages,
  piPackageNameFromSource,
  removePiPackage,
  updatePiPackages,
} from '@/lib/pi-runtime/packages';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { PiPluginConfigEditor } from './PiPluginConfigEditor';

interface RecoveryIntegration {
  descriptionKey: I18nKey;
  id: 'pi-workspace-history' | 'pi-wtf';
  source: string;
  title: string;
}

type RecoveryPackageAction = 'install' | 'remove' | 'update';

const PACKAGE_ACTION_TOAST_KEYS: Record<RecoveryPackageAction, {
  failure: I18nKey;
  success: I18nKey;
}> = {
  install: {
    success: 'settings.piarium.recovery.toast.installComplete',
    failure: 'settings.piarium.recovery.toast.installFailed',
  },
  remove: {
    success: 'settings.piarium.recovery.toast.removeComplete',
    failure: 'settings.piarium.recovery.toast.removeFailed',
  },
  update: {
    success: 'settings.piarium.recovery.toast.updateComplete',
    failure: 'settings.piarium.recovery.toast.updateFailed',
  },
};

const RECOVERY_PREFERENCES: Array<{
  descriptionKey: I18nKey;
  labelKey: I18nKey;
  value: RecoveryPreference;
}> = [
  {
    value: 'conversation',
    labelKey: 'settings.piarium.recovery.preference.conversation.label',
    descriptionKey: 'settings.piarium.recovery.preference.conversation.description',
  },
  {
    value: 'both',
    labelKey: 'settings.piarium.recovery.preference.both.label',
    descriptionKey: 'settings.piarium.recovery.preference.both.description',
  },
  {
    value: 'ask',
    labelKey: 'settings.piarium.recovery.preference.ask.label',
    descriptionKey: 'settings.piarium.recovery.preference.ask.description',
  },
];

const RECOVERY_INTEGRATIONS: RecoveryIntegration[] = [
  {
    id: 'pi-workspace-history',
    source: 'npm:pi-workspace-history',
    title: 'pi-workspace-history',
    descriptionKey: 'settings.piarium.recovery.providers.workspaceHistory.description',
  },
  {
    id: 'pi-wtf',
    source: 'npm:pi-wtf',
    title: 'pi-wtf',
    descriptionKey: 'settings.piarium.recovery.providers.wtf.description',
  },
];

export const RecoverySettings: React.FC = () => {
  const { t } = useI18n();
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const preference = useUIStore((state) => state.recoveryPreference);
  const setPreference = useUIStore((state) => state.setRecoveryPreference);
  const [packages, setPackages] = React.useState<PackageDescriptor[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [busyPackageAction, setBusyPackageAction] = React.useState<{
    action: RecoveryPackageAction;
    source: string;
  } | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [customSource, setCustomSource] = React.useState('');
  const discoveredProviders = usePiSessionStore((state) => {
    if (state.currentSessionId === null) return [];
    return state.records[state.currentSessionId]?.recoveryStatus?.providers ?? [];
  });
  const currentDirectoryRef = React.useRef(currentDirectory);
  const refreshGenerationRef = React.useRef(0);
  currentDirectoryRef.current = currentDirectory;

  const refresh = React.useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    const runtimeKey = getRuntimeKey();
    setLoading(true);
    setLoaded(false);
    setPackages([]);
    setLoadError(null);
    try {
      const next = await listPiPackages({ cwd: currentDirectory });
      if (generation !== refreshGenerationRef.current || runtimeKey !== getRuntimeKey()) return;
      setPackages(next);
      setLoaded(true);
    } catch (error) {
      if (generation !== refreshGenerationRef.current || runtimeKey !== getRuntimeKey()) return;
      const message = error instanceof Error ? error.message : String(error);
      setLoadError(message);
    } finally {
      if (generation === refreshGenerationRef.current && runtimeKey === getRuntimeKey()) {
        setLoading(false);
      }
    }
  }, [currentDirectory]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const changePreference = React.useCallback((next: RecoveryPreference) => {
    setPreference(next);
    void updateDesktopSettings({ recoveryPreference: next });
  }, [setPreference]);

  const runPackageAction = React.useCallback(async (
    action: RecoveryPackageAction,
    source: string,
  ) => {
    const actionDirectory = currentDirectory;
    const runtimeKey = getRuntimeKey();
    setBusyPackageAction({ action, source });
    try {
      if (action === 'install') {
        await installPiPackage({ cwd: currentDirectory }, source);
      } else if (action === 'remove') {
        const result = await removePiPackage({ cwd: currentDirectory }, source);
        if (!result.removed) throw new Error(`Pi package is not configured: ${source}`);
      } else {
        await updatePiPackages({ cwd: currentDirectory }, source);
      }
      if (currentDirectoryRef.current === actionDirectory && getRuntimeKey() === runtimeKey) {
        await refresh();
      }
      toast.success(t(PACKAGE_ACTION_TOAST_KEYS[action].success));
    } catch (error) {
      console.error(`Failed to ${action} Pi recovery package:`, error);
      toast.error(t(PACKAGE_ACTION_TOAST_KEYS[action].failure));
    } finally {
      setBusyPackageAction(null);
    }
  }, [currentDirectory, refresh, t]);

  const normalizedCustomSource = customSource.trim();
  const customConfigured = normalizedCustomSource.length === 0
    ? undefined
    : packages.find((candidate) => candidate.source === normalizedCustomSource)
      ?? findPiPackage(packages, piPackageNameFromSource(normalizedCustomSource));
  const customBusyAction = busyPackageAction?.source === normalizedCustomSource
    ? busyPackageAction.action
    : null;
  const additionalProviders = discoveredProviders.filter((provider) => (
    provider.id !== 'pi-native'
    && provider.id !== 'pi-workspace-history'
    && provider.id !== 'pi-wtf'
  ));

  return (
    <SettingsSection
      settingsItem="sessions.recovery"
      title={t('settings.piarium.recovery.title')}
      description={t('settings.piarium.recovery.description')}
    >
      <SettingsRadioGroup aria-label={t('settings.piarium.recovery.preference.aria')}>
        {RECOVERY_PREFERENCES.map((option) => (
          <SettingsRadioOption
            key={option.value}
            selected={preference === option.value}
            onSelect={() => changePreference(option.value)}
            label={t(option.labelKey)}
            description={t(option.descriptionKey)}
            ariaLabel={t(option.labelKey)}
          />
        ))}
      </SettingsRadioGroup>

      <div className="border-t border-border/60 pt-5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-0.5">
            <h3 className="typography-settings-group-title text-foreground">
              {t('settings.piarium.recovery.providers.title')}
            </h3>
            <p className="typography-meta text-muted-foreground">
              {t('settings.piarium.recovery.providers.description')}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => void refresh()}
            disabled={loading || busyPackageAction !== null}
            className="!font-normal gap-1.5"
          >
            <Icon name="refresh" className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
            {t('settings.piarium.recovery.actions.refresh')}
          </Button>
        </div>

        <div className="rounded-lg border border-border/60 px-3 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <Icon name="chat-history" className="size-4 text-[var(--status-success)]" />
                <span className="typography-ui-label text-foreground">Pi session tree</span>
                <span className="typography-micro text-[var(--status-success)]">
                  {t('settings.piarium.recovery.status.native')}
                </span>
              </div>
              <p className="typography-meta text-muted-foreground">
                {t('settings.piarium.recovery.providers.sessionTree.description')}
              </p>
            </div>
          </div>
        </div>

        {RECOVERY_INTEGRATIONS.map((integration) => {
          const configured = findPiPackage(packages, integration.id);
          const source = configured?.source ?? integration.source;
          const busyAction = busyPackageAction?.source === source
            ? busyPackageAction.action
            : null;
          return (
            <div key={integration.id} className="rounded-lg border border-border/60 px-3 py-3">
              <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Icon
                      name="plug-2"
                      className={configured ? 'size-4 text-[var(--status-success)]' : 'size-4 text-muted-foreground'}
                    />
                    <span className="typography-ui-label text-foreground">{integration.title}</span>
                    {loaded && (
                      <span className={configured
                        ? 'typography-micro text-[var(--status-success)]'
                        : 'typography-micro text-muted-foreground'}>
                        {configured
                          ? t('settings.piarium.recovery.status.configured')
                          : t('settings.piarium.recovery.status.notConfigured')}
                      </span>
                    )}
                  </div>
                  <p className="typography-meta text-muted-foreground">
                    {t(integration.descriptionKey)}
                  </p>
                  <p className="typography-micro font-mono text-muted-foreground break-all">{source}</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {loaded && (configured ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={busyPackageAction !== null}
                        onClick={() => void runPackageAction('update', source)}
                        className="!font-normal"
                      >
                        {busyAction === 'update' ? t('settings.piarium.recovery.actions.updating') : t('settings.piarium.recovery.actions.update')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled={busyPackageAction !== null}
                        onClick={() => void runPackageAction('remove', source)}
                        className="!font-normal text-muted-foreground"
                      >
                        {busyAction === 'remove' ? t('settings.piarium.recovery.actions.removing') : t('settings.piarium.recovery.actions.remove')}
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={busyPackageAction !== null}
                      onClick={() => void runPackageAction('install', source)}
                      className="!font-normal"
                    >
                      {busyAction === 'install' ? t('settings.piarium.recovery.actions.installing') : t('settings.piarium.recovery.actions.install')}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          );
        })}

        <div className="rounded-lg border border-border/60 px-3 py-3">
          <div className="space-y-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Icon name="plug-2" className="size-4 text-muted-foreground" />
                <span className="typography-ui-label text-foreground">
                  {t('settings.piarium.recovery.providers.custom.title')}
                </span>
              </div>
              <p className="typography-meta text-muted-foreground">
                {t('settings.piarium.recovery.providers.custom.description')}
              </p>
            </div>
            <form
              className="flex flex-col gap-2 @xl:flex-row"
              onSubmit={(event) => {
                event.preventDefault();
                if (normalizedCustomSource.length === 0) return;
                void runPackageAction(customConfigured ? 'update' : 'install', normalizedCustomSource);
              }}
            >
              <Input
                value={customSource}
                onChange={(event) => setCustomSource(event.target.value)}
                placeholder={t('settings.piarium.recovery.providers.custom.placeholder')}
                disabled={busyPackageAction !== null}
                className="min-w-0 flex-1 font-mono"
              />
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="submit"
                  variant="outline"
                  size="xs"
                  disabled={normalizedCustomSource.length === 0 || busyPackageAction !== null}
                  className="!font-normal"
                >
                  {customConfigured
                    ? (customBusyAction === 'update'
                        ? t('settings.piarium.recovery.actions.updating')
                        : t('settings.piarium.recovery.actions.update'))
                    : (customBusyAction === 'install'
                        ? t('settings.piarium.recovery.actions.installing')
                        : t('settings.piarium.recovery.actions.install'))}
                </Button>
                {customConfigured && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={busyPackageAction !== null}
                    onClick={() => void runPackageAction('remove', customConfigured.source)}
                    className="!font-normal text-muted-foreground"
                  >
                    {customBusyAction === 'remove'
                      ? t('settings.piarium.recovery.actions.removing')
                      : t('settings.piarium.recovery.actions.remove')}
                  </Button>
                )}
              </div>
            </form>
          </div>
        </div>

        <PiPluginConfigEditor cwd={currentDirectory} />

        {additionalProviders.length > 0 && (
          <div className="space-y-2">
            <div className="space-y-0.5">
              <h4 className="typography-ui-label text-foreground">
                {t('settings.piarium.recovery.providers.discovered.title')}
              </h4>
              <p className="typography-meta text-muted-foreground">
                {t('settings.piarium.recovery.providers.discovered.description')}
              </p>
            </div>
            {additionalProviders.map((provider) => (
              <div key={provider.id} className="rounded-lg border border-border/60 px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Icon
                    name="plug-2"
                    className={provider.active
                      ? 'size-4 text-[var(--status-success)]'
                      : 'size-4 text-muted-foreground'}
                  />
                  <span className="typography-ui-label text-foreground">{provider.name}</span>
                  <span className={provider.active
                    ? 'typography-micro text-[var(--status-success)]'
                    : 'typography-micro text-muted-foreground'}>
                    {provider.active
                      ? t('settings.piarium.recovery.status.active')
                      : t('settings.piarium.recovery.status.inactive')}
                  </span>
                  {provider.bridgeVersion !== undefined && (
                    <span className="typography-micro text-muted-foreground">
                      bridge v{provider.bridgeVersion}
                    </span>
                  )}
                </div>
                <p className="mt-1 typography-micro text-muted-foreground">
                  {provider.id} · {provider.modes.join(', ')} · {provider.actions.join(', ')}
                </p>
                {provider.source && (
                  <button
                    type="button"
                    onClick={() => setCustomSource(provider.source ?? '')}
                    className="mt-1 block max-w-full break-all text-left font-mono typography-micro text-muted-foreground hover:text-foreground"
                  >
                    {provider.source}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {loadError && (
          <div className="flex items-start gap-2 rounded-lg bg-[var(--status-error)]/10 px-3 py-2 text-[var(--status-error)]">
            <Icon name="error-warning" className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0">
              <p className="typography-meta font-medium">{t('settings.piarium.recovery.status.loadFailed')}</p>
              <p className="typography-micro break-words opacity-80">{loadError}</p>
            </div>
          </div>
        )}

        <p className="typography-micro text-muted-foreground">
          {t('settings.piarium.recovery.providers.activationNote')}
        </p>
      </div>
    </SettingsSection>
  );
};
