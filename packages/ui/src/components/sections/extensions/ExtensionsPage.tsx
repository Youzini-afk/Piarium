import React from 'react';
import type {
  PiariumExtensionActualStatus,
  PiariumExtensionCatalogEntry,
  PiariumExtensionCapabilityReference,
} from '@piarium/extension-contract';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import {
  refreshPiariumExtensionCatalog,
  reviewPiariumExtensionCandidateCapabilities,
  setPiariumExtensionEnabled,
  usePiariumExtensionCatalog,
} from '@/lib/extensions/catalog-store';
import { useI18n, type I18nKey } from '@/lib/i18n';

const STATUS_KEYS: Readonly<Record<PiariumExtensionActualStatus, I18nKey>> = {
  active: 'settings.piarium.extensions.status.active',
  activating: 'settings.piarium.extensions.status.activating',
  deactivating: 'settings.piarium.extensions.status.deactivating',
  failed: 'settings.piarium.extensions.status.failed',
  inactive: 'settings.piarium.extensions.status.inactive',
  loading: 'settings.piarium.extensions.status.loading',
  resolving: 'settings.piarium.extensions.status.resolving',
  'restart-required': 'settings.piarium.extensions.status.restartRequired',
  'rolling-back': 'settings.piarium.extensions.status.rollingBack',
  updating: 'settings.piarium.extensions.status.updating',
  waiting: 'settings.piarium.extensions.status.waiting',
};

const actualStatus = (entry: PiariumExtensionCatalogEntry): PiariumExtensionActualStatus => {
  if (!entry.desired.enabled) return 'inactive';
  const statuses = entry.actual.map((state) => state.status);
  for (const status of ['restart-required', 'failed', 'rolling-back', 'updating', 'activating', 'loading', 'waiting', 'active'] as const) {
    if (statuses.includes(status)) return status;
  }
  return 'waiting';
};

const capabilityKey = (reference: PiariumExtensionCapabilityReference): string => (
  `${reference.realm}:${reference.capability}`
);

const ExtensionCard: React.FC<{
  busy: boolean;
  entry: PiariumExtensionCatalogEntry;
}> = ({ busy, entry }) => {
  const { t } = useI18n();
  const status = actualStatus(entry);
  const candidate = entry.candidate;
  const decisions = new Map(candidate?.capabilityGrants.map((grant) => [capabilityKey(grant), grant.granted]) ?? []);
  const review = async (reference: PiariumExtensionCapabilityReference, granted: boolean): Promise<void> => {
    if (!candidate) return;
    await reviewPiariumExtensionCandidateCapabilities({
      candidateIntegrity: candidate.integrity,
      decisions: [{ ...reference, granted }],
      extensionId: entry.manifest.id,
    });
  };

  return (
    <div className="rounded-lg border border-border/60 px-3 py-3">
      <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Icon
              name="plug-2"
              className={status === 'active'
                ? 'size-4 text-[var(--status-success)]'
                : status === 'failed' || status === 'restart-required'
                  ? 'size-4 text-[var(--status-error)]'
                  : 'size-4 text-muted-foreground'}
            />
            <span className="typography-ui-label text-foreground">
              {entry.manifest.displayName ?? entry.manifest.id}
            </span>
            <span className="rounded-md bg-interactive-hover px-1.5 py-0.5 typography-micro text-muted-foreground">
              {t(STATUS_KEYS[status])}
            </span>
            <span className="typography-micro text-muted-foreground">v{entry.selectedVersion}</span>
          </div>
          <p className="break-all font-mono typography-micro text-muted-foreground">{entry.manifest.id}</p>
          <p className="break-all typography-micro text-muted-foreground/80">
            {entry.source.display} · {entry.source.kind}
          </p>
        </div>
        <Switch
          checked={entry.desired.enabled}
          disabled={busy}
          onCheckedChange={(enabled) => {
            void setPiariumExtensionEnabled(entry.manifest.id, enabled).catch(() => undefined);
          }}
          aria-label={t('settings.piarium.extensions.actions.activationAria', {
            name: entry.manifest.displayName ?? entry.manifest.id,
          })}
        />
      </div>

      {candidate ? (
        <div className="mt-3 border-t border-border/50 pt-3">
          <div className="flex flex-wrap items-center gap-2 typography-meta">
            <span className="font-medium text-foreground">
              {t('settings.piarium.extensions.candidate.title', { version: candidate.resolvedVersion })}
            </span>
            {candidate.capabilitiesReviewed ? (
              <span className="text-[var(--status-success)]">
                {t('settings.piarium.extensions.candidate.reviewed')}
              </span>
            ) : null}
          </div>
          {candidate.capabilityDelta.added.length > 0 ? (
            <div className="mt-2 space-y-2">
              {candidate.capabilityDelta.added.map((reference) => {
                const key = capabilityKey(reference);
                const decision = decisions.get(key);
                return (
                  <div key={key} className="flex flex-col gap-2 rounded-md bg-interactive-hover px-2.5 py-2 @xl:flex-row @xl:items-center @xl:justify-between">
                    <code className="break-all typography-micro">{key}</code>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        type="button"
                        variant={decision === false ? 'secondary' : 'outline'}
                        size="xs"
                        disabled={busy}
                        onClick={() => { void review(reference, false).catch(() => undefined); }}
                      >
                        {t('settings.piarium.extensions.candidate.deny')}
                      </Button>
                      <Button
                        type="button"
                        variant={decision === true ? 'secondary' : 'outline'}
                        size="xs"
                        disabled={busy}
                        onClick={() => { void review(reference, true).catch(() => undefined); }}
                      >
                        {t('settings.piarium.extensions.candidate.allow')}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export const ExtensionsPage: React.FC = () => {
  const { t } = useI18n();
  const state = usePiariumExtensionCatalog();
  const extensions = state.snapshot?.catalog.extensions ?? [];
  return (
    <SettingsPageLayout
      title={t('settings.page.extensions.title')}
      headerEnd={(
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={state.loading}
          onClick={() => { void refreshPiariumExtensionCatalog().catch(() => undefined); }}
        >
          <Icon name="refresh" className={state.loading ? 'size-4 animate-spin' : 'size-4'} />
          {t('settings.piarium.extensions.actions.refresh')}
        </Button>
      )}
      showSaveStatus={false}
    >
      <SettingsSection divider={false} settingsItem="extensions.catalog">
        {state.error ? (
          <div className="mb-3 rounded-lg border border-[color-mix(in_srgb,var(--status-error)_24%,transparent)] bg-[color-mix(in_srgb,var(--status-error)_7%,transparent)] px-3 py-2 typography-meta text-[var(--status-error)]">
            {state.error}
          </div>
        ) : null}
        <div className="space-y-2">
          {extensions.map((entry) => (
            <ExtensionCard
              key={entry.manifest.id}
              entry={entry}
              busy={state.busyExtensionId === entry.manifest.id}
            />
          ))}
        </div>
        {extensions.length === 0 && !state.loading ? (
          <div className="rounded-lg border border-dashed border-border/60 px-4 py-8 text-center typography-ui text-muted-foreground">
            {t('settings.piarium.extensions.empty')}
          </div>
        ) : null}
      </SettingsSection>
    </SettingsPageLayout>
  );
};
