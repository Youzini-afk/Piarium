import React from 'react';
import type { PackageDescriptor, RuntimeContextTarget } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import {
  findPiPackage,
  installPiPackage,
  listPiPackages,
  piPackageNameFromSource,
  removePiPackage,
  updatePiPackages,
} from '@/lib/pi-runtime/packages';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useI18n, type I18nKey } from '@/lib/i18n';

type PackageAction = 'install' | 'remove' | 'update' | 'update-all';

interface RecommendedPackage {
  descriptionKey: I18nKey;
  name: string;
  source: string;
}

const RECOMMENDED_PACKAGES: RecommendedPackage[] = [
  {
    name: 'pi-subagents',
    source: 'npm:pi-subagents',
    descriptionKey: 'settings.piarium.plugins.package.subagents',
  },
  {
    name: '@cortexkit/pi-magic-context',
    source: 'npm:@cortexkit/pi-magic-context',
    descriptionKey: 'settings.piarium.plugins.package.magicContext',
  },
  {
    name: 'pi-mcp-adapter',
    source: 'npm:pi-mcp-adapter',
    descriptionKey: 'settings.piarium.plugins.package.mcp',
  },
  {
    name: 'pi-web-access',
    source: 'npm:pi-web-access',
    descriptionKey: 'settings.piarium.plugins.package.webAccess',
  },
  {
    name: 'pi-workspace-history',
    source: 'npm:pi-workspace-history',
    descriptionKey: 'settings.piarium.plugins.package.workspaceHistory',
  },
  {
    name: 'pi-wtf',
    source: 'npm:pi-wtf',
    descriptionKey: 'settings.piarium.plugins.package.wtf',
  },
];

const PACKAGE_ACTION_SUCCESS_KEYS = {
  install: 'settings.piarium.plugins.toast.install',
  remove: 'settings.piarium.plugins.toast.remove',
  update: 'settings.piarium.plugins.toast.update',
  'update-all': 'settings.piarium.plugins.toast.updateAll',
} satisfies Record<PackageAction, I18nKey>;

const packageActionLabel = (
  action: PackageAction | null,
  expected: PackageAction,
  t: ReturnType<typeof useI18n>['t'],
): string => {
  if (action === expected) {
    return expected === 'install'
      ? t('settings.piarium.recovery.actions.installing')
      : expected === 'remove'
        ? t('settings.piarium.recovery.actions.removing')
        : expected === 'update-all'
          ? t('settings.piarium.plugins.actions.updatingAll')
          : t('settings.piarium.recovery.actions.updating');
  }
  return expected === 'install'
    ? t('settings.piarium.recovery.actions.install')
    : expected === 'remove'
      ? t('settings.piarium.recovery.actions.remove')
      : expected === 'update-all'
        ? t('settings.piarium.plugins.actions.updateAll')
        : t('settings.piarium.recovery.actions.update');
};

const PackageStatus: React.FC<{ configured: boolean }> = ({ configured }) => {
  const { t } = useI18n();
  return (
    <span className={configured
      ? 'typography-micro text-[var(--status-success)]'
      : 'typography-micro text-muted-foreground'}>
      {configured
        ? t('settings.piarium.recovery.status.configured')
        : t('settings.piarium.recovery.status.notConfigured')}
    </span>
  );
};

export const PluginsPage: React.FC = () => {
  const { t } = useI18n();
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const activeSessionId = usePiSessionStore((state) => {
    const sessionId = state.currentSessionId;
    return sessionId && state.records[sessionId]?.open ? sessionId : null;
  });
  const runtimeTarget = React.useMemo<RuntimeContextTarget>(() => (
    activeSessionId ? { sessionId: activeSessionId } : { cwd: currentDirectory }
  ), [activeSessionId, currentDirectory]);
  const targetKey = activeSessionId ? `session:${activeSessionId}` : `cwd:${currentDirectory}`;
  const targetKeyRef = React.useRef(targetKey);
  targetKeyRef.current = targetKey;

  const [packages, setPackages] = React.useState<PackageDescriptor[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [customSource, setCustomSource] = React.useState('');
  const [busyAction, setBusyAction] = React.useState<{
    action: PackageAction;
    source?: string;
  } | null>(null);
  const refreshGenerationRef = React.useRef(0);

  const refresh = React.useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    const actionTargetKey = targetKey;
    const runtimeKey = getRuntimeKey();
    setLoading(true);
    setLoadError(null);
    try {
      const next = await listPiPackages(runtimeTarget);
      if (
        generation !== refreshGenerationRef.current
        || actionTargetKey !== targetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      setPackages([...next].sort((left, right) => (
        left.name.localeCompare(right.name) || left.source.localeCompare(right.source)
      )));
      setLoaded(true);
    } catch (error) {
      if (
        generation !== refreshGenerationRef.current
        || actionTargetKey !== targetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      setLoadError(error instanceof Error ? error.message : String(error));
      setLoaded(false);
    } finally {
      if (
        generation === refreshGenerationRef.current
        && actionTargetKey === targetKeyRef.current
        && runtimeKey === getRuntimeKey()
      ) setLoading(false);
    }
  }, [runtimeTarget, targetKey]);

  React.useEffect(() => {
    setPackages([]);
    setLoaded(false);
    void refresh();
  }, [refresh]);

  const runPackageAction = React.useCallback(async (
    action: PackageAction,
    source?: string,
  ) => {
    if (action !== 'update-all' && !source) return;
    const actionTargetKey = targetKey;
    const runtimeKey = getRuntimeKey();
    setBusyAction(source ? { action, source } : { action });
    try {
      if (action === 'install') {
        await installPiPackage(runtimeTarget, source!);
      } else if (action === 'remove') {
        const result = await removePiPackage(runtimeTarget, source!);
        if (!result.removed) throw new Error(`Pi package is not configured: ${source}`);
      } else if (action === 'update') {
        await updatePiPackages(runtimeTarget, source!);
      } else {
        await updatePiPackages(runtimeTarget);
      }
      if (actionTargetKey === targetKeyRef.current && runtimeKey === getRuntimeKey()) {
        await refresh();
      }
      toast.success(t(PACKAGE_ACTION_SUCCESS_KEYS[action]));
    } catch (error) {
      console.error(`Failed to ${action} Pi package:`, error);
      toast.error(t('settings.piarium.plugins.toast.failed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyAction(null);
    }
  }, [refresh, runtimeTarget, t, targetKey]);

  const normalizedCustomSource = customSource.trim();
  const customPackage = normalizedCustomSource
    ? packages.find((candidate) => candidate.source === normalizedCustomSource)
      ?? findPiPackage(packages, piPackageNameFromSource(normalizedCustomSource))
    : undefined;
  const missingRecommended = RECOMMENDED_PACKAGES.filter((item) => (
    findPiPackage(packages, item.name) === undefined
  ));
  const isBusy = busyAction !== null;

  return (
    <SettingsPageLayout
      title={t('settings.page.plugins.title')}
      description={t('settings.piarium.plugins.description')}
      className="max-w-6xl"
      showSaveStatus={false}
    >
      <SettingsSection
        settingsItem="plugins.packages"
        title={t('settings.piarium.plugins.configured.title')}
        description={t('settings.piarium.plugins.configured.description')}
        divider={false}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-[var(--surface-elevated)] px-3 py-3">
          <p className="max-w-3xl typography-meta text-muted-foreground">
            {t('settings.piarium.plugins.ownership')}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={isBusy || !loaded || packages.length === 0}
              onClick={() => void runPackageAction('update-all')}
              className="!font-normal"
            >
              {packageActionLabel(busyAction?.action ?? null, 'update-all', t)}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={isBusy || loading}
              onClick={() => void refresh()}
              className="!font-normal gap-1.5"
            >
              <Icon name="refresh" className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
              {t('settings.piarium.recovery.actions.refresh')}
            </Button>
          </div>
        </div>

        {loaded && packages.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 px-4 py-8 text-center typography-ui text-muted-foreground">
            {t('settings.piarium.plugins.configured.empty')}
          </div>
        ) : null}

        {packages.map((entry) => {
          const action = busyAction?.source === entry.source ? busyAction.action : null;
          return (
            <div key={entry.source} className="rounded-lg border border-border/60 px-3 py-3">
              <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Icon name="plug-2" className="size-4 text-[var(--status-success)]" />
                    <span className="typography-ui-label text-foreground">{entry.name}</span>
                    <PackageStatus configured />
                    {entry.version ? (
                      <span className="typography-micro text-muted-foreground">v{entry.version}</span>
                    ) : null}
                  </div>
                  <p className="break-all font-mono typography-micro text-muted-foreground">{entry.source}</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={isBusy}
                    onClick={() => void runPackageAction('update', entry.source)}
                    className="!font-normal"
                  >
                    {packageActionLabel(action, 'update', t)}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={isBusy}
                    onClick={() => void runPackageAction('remove', entry.source)}
                    className="!font-normal text-muted-foreground"
                  >
                    {packageActionLabel(action, 'remove', t)}
                  </Button>
                </div>
              </div>
            </div>
          );
        })}

        {loadError ? (
          <div className="flex items-start gap-2 rounded-lg bg-[var(--status-error)]/10 px-3 py-2 text-[var(--status-error)]">
            <Icon name="error-warning" className="mt-0.5 size-4 shrink-0" />
            <p className="min-w-0 break-words typography-meta">{loadError}</p>
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection
        settingsItem="plugins.recommended"
        title={t('settings.piarium.plugins.recommended.title')}
        description={t('settings.piarium.plugins.recommended.description')}
      >
        {RECOMMENDED_PACKAGES.map((item) => {
          const configured = findPiPackage(packages, item.name);
          const source = configured?.source ?? item.source;
          const action = busyAction?.source === source ? busyAction.action : null;
          return (
            <div key={item.name} className="rounded-lg border border-border/60 px-3 py-3">
              <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Icon
                      name="plug-2"
                      className={configured ? 'size-4 text-[var(--status-success)]' : 'size-4 text-muted-foreground'}
                    />
                    <span className="typography-ui-label text-foreground">{item.name}</span>
                    {loaded ? <PackageStatus configured={configured !== undefined} /> : null}
                  </div>
                  <p className="typography-meta text-muted-foreground">{t(item.descriptionKey)}</p>
                  <p className="break-all font-mono typography-micro text-muted-foreground">{source}</p>
                </div>
                {!configured && loaded ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={isBusy}
                    onClick={() => void runPackageAction('install', item.source)}
                    className="!font-normal"
                  >
                    {packageActionLabel(action, 'install', t)}
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
        {loaded && missingRecommended.length === 0 ? (
          <p className="typography-meta text-[var(--status-success)]">
            {t('settings.piarium.plugins.recommended.complete')}
          </p>
        ) : null}
      </SettingsSection>

      <SettingsSection
        settingsItem="plugins.source"
        title={t('settings.piarium.plugins.source.title')}
        description={t('settings.piarium.plugins.source.description')}
      >
        <form
          className="flex flex-col gap-2 @xl:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (!normalizedCustomSource) return;
            void runPackageAction(
              customPackage ? 'update' : 'install',
              customPackage?.source ?? normalizedCustomSource,
            );
          }}
        >
          <Input
            value={customSource}
            onChange={(event) => setCustomSource(event.target.value)}
            placeholder={t('settings.piarium.plugins.source.placeholder')}
            disabled={isBusy}
            className="min-w-0 flex-1 font-mono"
            spellCheck={false}
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={!normalizedCustomSource || isBusy}
            className="shrink-0 !font-normal"
          >
            {packageActionLabel(
              busyAction?.source === (customPackage?.source ?? normalizedCustomSource)
                ? busyAction.action
                : null,
              customPackage ? 'update' : 'install',
              t,
            )}
          </Button>
        </form>
      </SettingsSection>

    </SettingsPageLayout>
  );
};
