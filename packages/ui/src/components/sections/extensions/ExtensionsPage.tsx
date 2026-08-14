import React from 'react';
import type {
  PiariumExtensionActualStatus,
  PiariumExtensionCatalogEntry,
  PiariumExtensionCapabilityReference,
  PiariumExtensionServiceProviderSnapshot,
} from '@piarium/extension-contract';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import {
  refreshPiariumExtensionCatalog,
  reviewPiariumExtensionCandidateCapabilities,
  setPiariumExtensionServiceRoute,
  setPiariumExtensionEnabled,
  usePiariumExtensionCatalog,
} from '@/lib/extensions/catalog-store';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import {
  resolvePiariumExtensionServiceRouting,
  resolvePiariumWorkbenchLayout,
  serviceRoutingScopeKey,
} from '@piarium/extension-contract';
import {
  selectActiveWorkbenchProfile,
  setWorkbenchReplacementSelection,
  useSurfaceRegistrySnapshot,
  WORKBENCH_REPLACEMENT_TARGETS,
} from '@/lib/extensions/workbench-registry';
import { piariumSurfaceRuntime } from '@/lib/extensions/surface-runtime';

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

const WORKBENCH_TARGET_LABELS: Readonly<Record<string, I18nKey>> = {
  [WORKBENCH_REPLACEMENT_TARGETS.shell]: 'settings.piarium.extensions.workbench.target.shell',
  [WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator]: 'settings.piarium.extensions.workbench.target.navigator',
  [WORKBENCH_REPLACEMENT_TARGETS.chatTimeline]: 'settings.piarium.extensions.workbench.target.timeline',
  [WORKBENCH_REPLACEMENT_TARGETS.chatComposer]: 'settings.piarium.extensions.workbench.target.composer',
  [WORKBENCH_REPLACEMENT_TARGETS.agents]: 'settings.piarium.extensions.workbench.target.agents',
  [WORKBENCH_REPLACEMENT_TARGETS.mcp]: 'settings.piarium.extensions.workbench.target.mcp',
  [WORKBENCH_REPLACEMENT_TARGETS.workspaceExplorer]: 'settings.piarium.extensions.workbench.target.explorer',
  [WORKBENCH_REPLACEMENT_TARGETS.settings]: 'settings.piarium.extensions.workbench.target.settings',
};

const WorkbenchProfileSection: React.FC = () => {
  const { t } = useI18n();
  const catalog = usePiariumExtensionCatalog();
  const surface = useSurfaceRegistrySnapshot();
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const workbench = catalog.snapshot?.workbench;
  if (!workbench?.authoritative) return null;
  const resolved = resolvePiariumWorkbenchLayout(workbench.document, {
    surface: piariumSurfaceRuntime.surface,
    userId: 'default',
    ...(currentDirectory ? { workspaceId: currentDirectory } : {}),
  });
  const candidatesByTarget = new Map<string, typeof surface.contributions>();
  for (const contribution of surface.contributions) {
    const target = contribution.descriptor.replacement?.target;
    if (!target) continue;
    const current = candidatesByTarget.get(target) ?? [];
    candidatesByTarget.set(target, [...current, contribution]);
  }
  const targets = [...new Set([
    ...Object.keys(WORKBENCH_TARGET_LABELS),
    ...Object.keys(resolved.replacementSelections),
    ...candidatesByTarget.keys(),
  ])];
  const run = (operation: Promise<void>) => {
    void operation.catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
  };
  return (
    <SettingsSection title={t('settings.piarium.extensions.workbench.title')} settingsItem="extensions.workbench">
      <div className="space-y-3">
        <div className="grid gap-2 @xl:grid-cols-[minmax(0,1fr)_minmax(13rem,0.8fr)] @xl:items-center">
          <span className="typography-ui-label text-foreground">{t('settings.piarium.extensions.workbench.profile')}</span>
          <Select
            value={resolved.profileId}
            onValueChange={(profileId) => run(selectActiveWorkbenchProfile(profileId, currentDirectory || undefined))}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {workbench.document.profiles.map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>{profile.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {targets.map((target) => {
          const candidates = candidatesByTarget.get(target) ?? [];
          const selected = resolved.replacementSelections[target] ?? '__builtin__';
          const selectedMissing = selected !== '__builtin__'
            && !candidates.some((candidate) => candidate.descriptor.id === selected);
          return (
            <div key={target} className="grid gap-2 @xl:grid-cols-[minmax(0,1fr)_minmax(13rem,0.8fr)] @xl:items-center">
              <div className="min-w-0">
                <span className="typography-ui-label text-foreground">
                  {WORKBENCH_TARGET_LABELS[target] ? t(WORKBENCH_TARGET_LABELS[target]) : target}
                </span>
              </div>
              <Select
                value={selected}
                onValueChange={(value) => run(setWorkbenchReplacementSelection(
                  target,
                  value === '__builtin__' ? null : value,
                  currentDirectory
                    ? { scope: 'workspace', scopeId: currentDirectory }
                    : { scope: 'user', scopeId: 'default' },
                ))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__builtin__">{t('settings.piarium.extensions.workbench.builtin')}</SelectItem>
                  {selectedMissing ? <SelectItem value={selected}>{selected}</SelectItem> : null}
                  {candidates.map((candidate) => (
                    <SelectItem key={candidate.descriptor.id} value={candidate.descriptor.id}>
                      {candidate.descriptor.title ?? candidate.descriptor.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>
    </SettingsSection>
  );
};

const serviceName = (serviceId: string): string => {
  const tail = serviceId.split('.').filter(Boolean).at(-1) ?? serviceId;
  return tail.replace(/[-_]+/g, ' ').replace(/\b\w/g, (value) => value.toUpperCase());
};

const ServiceRoutingSection: React.FC = () => {
  const { t } = useI18n();
  const catalog = usePiariumExtensionCatalog();
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const [scopeKind, setScopeKind] = React.useState<'user' | 'workspace'>(currentDirectory ? 'workspace' : 'user');
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!currentDirectory && scopeKind === 'workspace') setScopeKind('user');
  }, [currentDirectory, scopeKind]);
  const snapshot = catalog.snapshot;
  if (!snapshot?.routing.authoritative) return null;

  const activeProviders = snapshot.services.providers.filter((provider) => provider.status === 'active');
  const providerGroups = new Map<string, PiariumExtensionServiceProviderSnapshot[]>();
  for (const provider of activeProviders) {
    const key = `${provider.descriptor.id}@${provider.descriptor.version}`;
    providerGroups.set(key, [...(providerGroups.get(key) ?? []), provider]);
  }
  const serviceKeys = new Set([
    ...[...providerGroups].filter(([, providers]) => providers.length > 1).map(([key]) => key),
    ...snapshot.routing.document.rules.map((rule) => `${rule.serviceId}@${rule.version}`),
  ]);
  if (serviceKeys.size === 0) return null;

  const editableScope = scopeKind === 'workspace' && currentDirectory
    ? { workspaceId: currentDirectory }
    : { userId: 'default' };
  const routingContext = currentDirectory
    ? { userId: 'default', workspaceId: currentDirectory }
    : { userId: 'default' };
  const editableScopeKey = serviceRoutingScopeKey(editableScope);
  const extensionNames = new Map(snapshot.catalog.extensions.map((entry) => [
    entry.manifest.id,
    entry.manifest.displayName ?? entry.manifest.id,
  ]));

  const selectProvider = async (
    serviceId: string,
    version: number,
    providerKey: string | null,
  ): Promise<void> => {
    const key = `${serviceId}@${version}`;
    setBusyKey(key);
    try {
      await setPiariumExtensionServiceRoute(serviceId, version, editableScope, providerKey);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey((current) => current === key ? null : current);
    }
  };

  return (
    <SettingsSection title={t('settings.piarium.extensions.routing.title')} settingsItem="extensions.routing">
      <div className="space-y-3">
        <div className="flex justify-end">
          <Select
            value={scopeKind}
            onValueChange={(value) => setScopeKind(value === 'workspace' ? 'workspace' : 'user')}
          >
            <SelectTrigger className="w-full @xl:w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="user">{t('settings.piarium.extensions.routing.scope.user')}</SelectItem>
              <SelectItem value="workspace" disabled={!currentDirectory}>
                {t('settings.piarium.extensions.routing.scope.workspace')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {[...serviceKeys].sort().map((key) => {
          const separator = key.lastIndexOf('@');
          const id = key.slice(0, separator);
          const version = Number(key.slice(separator + 1));
          const providers = providerGroups.get(key) ?? [];
          const exactRule = snapshot.routing.document.rules.find((rule) => (
            rule.serviceId === id
            && rule.version === version
            && serviceRoutingScopeKey(rule.scope) === editableScopeKey
          ));
          const selected = exactRule?.providerKey ?? '__automatic__';
          const selectedMissing = selected !== '__automatic__'
            && !providers.some((provider) => provider.providerKey === selected);
          const resolution = resolvePiariumExtensionServiceRouting({
            candidates: providers.map((provider) => ({ providerId: provider.providerId, providerKey: provider.providerKey })),
            context: routingContext,
            document: snapshot.routing.document,
            serviceId: id,
            version,
          });
          return (
            <div key={key} className="grid gap-2 rounded-lg border border-border/60 px-3 py-3 @xl:grid-cols-[minmax(0,1fr)_minmax(14rem,0.8fr)] @xl:items-center">
              <div className="min-w-0">
                <div className="typography-ui-label text-foreground">{serviceName(id)}</div>
                <div className={resolution.status === 'resolved'
                  ? 'typography-micro text-muted-foreground'
                  : 'typography-micro text-[var(--status-warning)]'}>
                  {resolution.status === 'resolved'
                    ? t('settings.piarium.extensions.routing.status.ready')
                    : resolution.status === 'ambiguous'
                      ? t('settings.piarium.extensions.routing.status.choose')
                      : t('settings.piarium.extensions.routing.status.unavailable')}
                </div>
              </div>
              <Select
                value={selected}
                disabled={busyKey === key}
                onValueChange={(value) => { void selectProvider(id, version, value === '__automatic__' ? null : value); }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__automatic__">{t('settings.piarium.extensions.routing.automatic')}</SelectItem>
                  {selectedMissing ? (
                    <SelectItem value={selected}>{t('settings.piarium.extensions.routing.missing')}</SelectItem>
                  ) : null}
                  {providers.map((provider) => (
                    <SelectItem key={provider.providerKey} value={provider.providerKey}>
                      {extensionNames.get(provider.extensionId) ?? provider.extensionId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>
    </SettingsSection>
  );
};

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
      <ServiceRoutingSection />
      <WorkbenchProfileSection />
    </SettingsPageLayout>
  );
};
