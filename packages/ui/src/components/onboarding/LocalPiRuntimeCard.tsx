import React from 'react';
import type { PiRuntimeSnapshot } from '@piarium/protocol';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { piRuntimeSourceLabelKey } from '@/lib/pi-runtime/source-label';
import { cn } from '@/lib/utils';

interface LocalPiRuntimeCardProps {
  onContinue: () => Promise<void> | void;
}

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const discoveredInstall = (snapshot: PiRuntimeSnapshot) => (
  snapshot.active
  ?? snapshot.installations.find((entry) => entry.id === 'system' || entry.id === 'standalone')
  ?? snapshot.installations.find((entry) => entry.state !== 'missing')
);

export function LocalPiRuntimeCard({ onContinue }: LocalPiRuntimeCardProps) {
  const { t } = useI18n();
  const { piRuntime } = useRuntimeAPIs();
  const [snapshot, setSnapshot] = React.useState<PiRuntimeSnapshot>({
    installations: [],
    status: 'discovering',
  });
  const [busy, setBusy] = React.useState(false);
  const [customPath, setCustomPath] = React.useState('');
  const [showCustomPath, setShowCustomPath] = React.useState(false);
  const mountedRef = React.useRef(true);

  const applySnapshot = React.useCallback((next: PiRuntimeSnapshot) => {
    if (mountedRef.current) setSnapshot(next);
  }, []);

  React.useEffect(() => {
    mountedRef.current = true;
    if (!piRuntime) {
      applySnapshot({
        installations: [],
        issue: t('onboarding.localSetup.errors.managerUnavailable'),
        status: 'failed',
      });
      return () => {
        mountedRef.current = false;
      };
    }
    const unsubscribe = piRuntime.subscribe(applySnapshot);
    void piRuntime.getSnapshot().then(applySnapshot).catch((error) => {
      applySnapshot({
        installations: [],
        issue: errorMessage(error),
        status: 'failed',
      });
    });
    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
  }, [applySnapshot, piRuntime, t]);

  const runAction = React.useCallback(async (work: () => Promise<PiRuntimeSnapshot | void>) => {
    setBusy(true);
    try {
      const next = await work();
      if (next) applySnapshot(next);
    } catch (error) {
      applySnapshot({
        ...snapshot,
        issue: errorMessage(error),
        status: 'failed',
      });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [applySnapshot, snapshot]);

  const installation = discoveredInstall(snapshot);
  const status = snapshot.status;
  const busyStatus = status === 'discovering' || status === 'installing' || status === 'upgrading' || status === 'probing' || busy;
  const sourceLabel = installation
    ? t(piRuntimeSourceLabelKey(installation.source))
    : '';

  const title = status === 'ready'
    ? t('onboarding.localSetup.status.readyWithVersion', { version: installation?.version ?? '' })
    : status === 'missing'
      ? t('onboarding.localSetup.status.missing')
      : status === 'upgrade-required'
        ? t('onboarding.localSetup.status.upgradeRequired')
        : status === 'failed'
          ? t('onboarding.localSetup.status.failed')
          : status === 'installing'
            ? t('onboarding.localSetup.status.installing')
            : status === 'upgrading'
              ? t('onboarding.localSetup.status.upgrading')
              : status === 'probing'
                ? t('onboarding.localSetup.status.probing')
                : t('onboarding.localSetup.status.discovering');

  const detail = status === 'ready' && installation
    ? t('onboarding.localSetup.status.readyDetail', {
        source: sourceLabel,
        commandPath: installation.commandPath ?? installation.packageRoot ?? '',
      })
    : status === 'missing'
      ? t('onboarding.localSetup.status.missingDetail')
      : status === 'upgrade-required'
        ? t('onboarding.localSetup.status.upgradeRequiredDetail', {
            currentVersion: installation?.version ?? snapshot.installPlan?.currentVersion ?? '',
            targetVersion: snapshot.installPlan?.targetVersion ?? '',
          })
        : status === 'failed'
          ? snapshot.issue ?? t('onboarding.localSetup.status.failed')
          : snapshot.installPlan?.reason || t('onboarding.localSetup.status.checkingDetail');

  const handleUseThisPi = React.useCallback(async () => {
    if (!installation || !piRuntime) return;
    await runAction(async () => {
      const next = installation.id === snapshot.selectedId || snapshot.active?.id === installation.id
        ? snapshot
        : await piRuntime.activate(installation.id);
      if (next.status === 'ready') await onContinue();
      return next;
    });
  }, [installation, onContinue, piRuntime, runAction, snapshot]);

  const handleSelectExisting = React.useCallback(async () => {
    if (!piRuntime) return;
    if (piRuntime.capabilities.pickPackageRoot) {
      await runAction(async () => {
        const packageRoot = await piRuntime.pickPackageRoot();
        if (!packageRoot) return snapshot;
        return piRuntime.activateCustom(packageRoot);
      });
      return;
    }
    setShowCustomPath(true);
  }, [piRuntime, runAction, snapshot]);

  const handleApplyCustomPath = React.useCallback(async () => {
    if (!piRuntime || !customPath.trim()) return;
    await runAction(() => piRuntime.activateCustom(customPath.trim()));
  }, [customPath, piRuntime, runAction]);

  return (
    <div className="app-region-no-drag space-y-4">
      <div
        className={cn(
          'rounded-xl border px-4 py-4 text-left',
          status === 'ready' && 'border-[var(--status-success)]/30 bg-[var(--status-success)]/5',
          (status === 'failed' || status === 'upgrade-required') && 'border-destructive/40 bg-destructive/5',
          (status === 'discovering' || status === 'installing' || status === 'upgrading' || status === 'probing' || status === 'missing')
            && 'border-border bg-background/50',
        )}
        role="status"
        aria-live="polite"
      >
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'mt-1.5 size-2.5 shrink-0 rounded-full',
              status === 'ready' && 'bg-[var(--status-success)]',
              (status === 'failed' || status === 'upgrade-required') && 'bg-destructive',
              (status === 'discovering' || status === 'installing' || status === 'upgrading' || status === 'probing') && 'animate-pulse bg-primary',
              status === 'missing' && 'bg-muted-foreground',
            )}
            aria-hidden
          />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="typography-ui-label font-medium text-foreground">{title}</p>
            <p className={cn(
              'break-words typography-meta',
              status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
            )}>
              {detail}
            </p>
          </div>
        </div>

        {installation && (status === 'ready' || status === 'upgrade-required' || status === 'failed') ? (
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border/50 pt-3 typography-meta">
            <div>
              <dt className="text-muted-foreground">{t('onboarding.localSetup.runtime.piVersion')}</dt>
              <dd className="font-mono text-foreground">{installation.version ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('onboarding.localSetup.runtime.source')}</dt>
              <dd className="font-mono text-foreground">{sourceLabel}</dd>
            </div>
            {installation.commandPath ? (
              <div className="col-span-2">
                <dt className="text-muted-foreground">{t('onboarding.localSetup.runtime.commandPath')}</dt>
                <dd className="break-all font-mono text-foreground">{installation.commandPath}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        {snapshot.installPlan && (status === 'missing' || status === 'upgrade-required') && snapshot.installPlan.manager ? (
          <p className="mt-3 typography-meta text-muted-foreground">
            {t('onboarding.localSetup.installPlan.summary', {
              manager: snapshot.installPlan.manager,
              version: snapshot.installPlan.targetVersion,
            })}
            {snapshot.installPlan.location
              ? ` ${t('onboarding.localSetup.installPlan.location', { location: snapshot.installPlan.location })}`
              : ''}
          </p>
        ) : null}
      </div>

      {status === 'ready' ? (
        <Button
          type="button"
          size="lg"
          className="w-full"
          data-pi-local-runtime-continue="true"
          disabled={busyStatus}
          onClick={() => void handleUseThisPi()}
        >
          {busy ? t('onboarding.localSetup.actions.continuing') : t('onboarding.localSetup.actions.useThisPi')}
        </Button>
      ) : null}

      {status === 'missing' ? (
        <div className="space-y-2">
          <Button
            type="button"
            size="lg"
            className="w-full"
            disabled={busyStatus || !piRuntime?.capabilities.install}
            onClick={() => void runAction(() => piRuntime!.install())}
          >
            {t('onboarding.localSetup.actions.installPi')}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={busyStatus}
            onClick={() => void handleSelectExisting()}
          >
            {t('onboarding.localSetup.actions.selectExisting')}
          </Button>
        </div>
      ) : null}

      {status === 'upgrade-required' ? (
        <Button
          type="button"
          size="lg"
          className="w-full"
          disabled={busyStatus || !piRuntime?.capabilities.install}
          onClick={() => void runAction(() => piRuntime!.upgrade())}
        >
          {t('onboarding.localSetup.actions.upgradePi')}
        </Button>
      ) : null}

      {status === 'failed' ? (
        <div className="space-y-2">
          <Button
            type="button"
            size="lg"
            className="w-full"
            disabled={busyStatus || !piRuntime}
            onClick={() => void runAction(() => piRuntime!.refresh())}
          >
            {t('onboarding.localSetup.actions.retryDetect')}
          </Button>
          {piRuntime?.capabilities.install ? (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={busyStatus}
              onClick={() => void runAction(() => piRuntime.upgrade())}
            >
              {t('onboarding.localSetup.actions.upgradePi')}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={busyStatus}
            onClick={() => void handleSelectExisting()}
          >
            {t('onboarding.localSetup.actions.selectExisting')}
          </Button>
        </div>
      ) : null}

      {showCustomPath ? (
        <div className="flex gap-2">
          <Input
            value={customPath}
            onChange={(event) => setCustomPath(event.target.value)}
            placeholder={t('onboarding.localSetup.customPath.placeholder')}
          />
          <Button type="button" variant="outline" disabled={busyStatus || !customPath.trim()} onClick={() => void handleApplyCustomPath()}>
            {t('onboarding.localSetup.customPath.apply')}
          </Button>
        </div>
      ) : null}

      {busyStatus && status !== 'ready' && status !== 'missing' && status !== 'failed' && status !== 'upgrade-required' ? (
        <Button type="button" size="lg" className="w-full" disabled>
          {t('onboarding.localSetup.actions.checking')}
        </Button>
      ) : null}
    </div>
  );
}
