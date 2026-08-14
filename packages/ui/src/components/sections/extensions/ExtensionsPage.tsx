import React from 'react';
import type {
  PiariumExtensionActualStatus,
  PiariumExtensionCatalogEntry,
  PiariumExtensionCapabilityReference,
  PiariumExtensionHostStateSnapshot,
  PiariumExtensionServiceProviderSnapshot,
} from '@piarium/extension-contract';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsRadioGroup,
  SettingsRadioOption,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import {
  refreshPiariumExtensionCatalog,
  discardPiariumExtensionCandidate,
  installPiariumExtension,
  reloadPiariumExtensionLocalSource,
  removePiariumExtension,
  reviewPiariumExtensionCapabilities,
  reviewPiariumExtensionCandidateCapabilities,
  selectPiariumExtensionCandidate,
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
  applyWorkbenchProfile,
  removeWorkbenchProfile,
  setWorkbenchReplacementSelection,
  upsertWorkbenchProfile,
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
  for (const status of ['restart-required', 'failed', 'rolling-back', 'updating', 'deactivating', 'activating', 'loading', 'resolving', 'waiting', 'active'] as const) {
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
  const [createOpen, setCreateOpen] = React.useState(false);
  const [removeOpen, setRemoveOpen] = React.useState(false);
  const [profileName, setProfileName] = React.useState('');
  const [profileBusy, setProfileBusy] = React.useState(false);
  const workbench = catalog.snapshot?.workbench;
  if (!workbench?.authoritative) return null;
  const resolved = resolvePiariumWorkbenchLayout(workbench.document, {
    surface: piariumSurfaceRuntime.surface,
    userId: 'default',
    ...(currentDirectory ? { workspaceId: currentDirectory } : {}),
  });
  const profile = workbench.document.profiles.find((candidate) => candidate.id === resolved.profileId);
  if (!profile) return null;
  const installedExtensions = catalog.snapshot?.catalog.extensions ?? [];
  const installedExtensionIds = new Set(installedExtensions.map((entry) => entry.manifest.id));
  const selectedExtensions = new Set(profile.extensionIds
    ?? installedExtensions.filter((entry) => entry.desired.enabled).map((entry) => entry.manifest.id));
  const missingExtensionIds = [...selectedExtensions].filter((extensionId) => !installedExtensionIds.has(extensionId)).sort();
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
  const updateExtensionSet = async (extensionId: string, enabled: boolean): Promise<void> => {
    const next = new Set(selectedExtensions);
    if (enabled) next.add(extensionId);
    else next.delete(extensionId);
    setProfileBusy(true);
    try {
      await upsertWorkbenchProfile({ ...profile, extensionIds: [...next].sort() });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setProfileBusy(false);
    }
  };
  const createProfile = async (): Promise<void> => {
    const label = profileName.trim();
    if (!label) return;
    const slug = label.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    const generated = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const id = slug || `profile-${generated}`;
    if (workbench.document.profiles.some((candidate) => candidate.id === id)) {
      toast.error(t('settings.piarium.extensions.workbench.profileExists'));
      return;
    }
    setProfileBusy(true);
    try {
      await upsertWorkbenchProfile({ extensionIds: [...selectedExtensions].sort(), id, label });
      await selectActiveWorkbenchProfile(id, currentDirectory || undefined);
      setProfileName('');
      setCreateOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setProfileBusy(false);
    }
  };
  return (
    <SettingsSection title={t('settings.piarium.extensions.workbench.title')} settingsItem="extensions.workbench">
      <div className="space-y-3">
        <div className="grid gap-2 @xl:grid-cols-[minmax(0,1fr)_minmax(13rem,0.8fr)] @xl:items-center">
          <span className="typography-ui-label text-foreground">{t('settings.piarium.extensions.workbench.profile')}</span>
          <div className="flex min-w-0 gap-2">
            <Select
              value={resolved.profileId}
              onValueChange={(profileId) => run(selectActiveWorkbenchProfile(profileId, currentDirectory || undefined))}
            >
              <SelectTrigger className="min-w-0 flex-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {workbench.document.profiles.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>{candidate.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="button" variant="outline" size="icon" onClick={() => setCreateOpen(true)} aria-label={t('settings.piarium.extensions.workbench.createProfile')}>
              <Icon name="add" className="size-4" />
            </Button>
            {workbench.document.profiles.length > 1 ? (
              <Button type="button" variant="ghost" size="icon" onClick={() => setRemoveOpen(true)} aria-label={t('settings.piarium.extensions.workbench.removeProfile')}>
                <Icon name="delete-bin" className="size-4" />
              </Button>
            ) : null}
          </div>
        </div>
        <div className="rounded-lg border border-border/60 px-3 py-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="typography-ui-label text-foreground">{t('settings.piarium.extensions.workbench.extensionSet')}</span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={profileBusy || profile.extensionIds === undefined}
              onClick={() => {
                setProfileBusy(true);
                void applyWorkbenchProfile(profile.id).catch((error) => {
                  toast.error(error instanceof Error ? error.message : String(error));
                }).finally(() => setProfileBusy(false));
              }}
            >
              {t('settings.piarium.extensions.workbench.applyProfile')}
            </Button>
          </div>
          <div className="grid gap-2 @2xl:grid-cols-2">
            {installedExtensions.map((entry) => (
              <label key={entry.manifest.id} className="flex min-w-0 items-center justify-between gap-3 rounded-md bg-interactive-hover px-2.5 py-2">
                <span className="min-w-0 truncate typography-meta text-foreground">
                  {entry.manifest.displayName ?? entry.manifest.id}
                </span>
                <Switch
                  checked={selectedExtensions.has(entry.manifest.id)}
                  disabled={profileBusy}
                  onCheckedChange={(enabled) => { void updateExtensionSet(entry.manifest.id, enabled); }}
                />
              </label>
            ))}
            {missingExtensionIds.map((extensionId) => (
              <label key={extensionId} className="flex min-w-0 items-center justify-between gap-3 rounded-md bg-interactive-hover px-2.5 py-2">
                <span className="min-w-0">
                  <span className="block truncate typography-meta text-foreground">{extensionId}</span>
                  <span className="block typography-micro text-muted-foreground">{t('settings.piarium.extensions.workbench.notInstalled')}</span>
                </span>
                <Switch
                  checked
                  disabled={profileBusy}
                  onCheckedChange={(enabled) => { void updateExtensionSet(extensionId, enabled); }}
                />
              </label>
            ))}
          </div>
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

      <Dialog open={createOpen} onOpenChange={(open) => !profileBusy && setCreateOpen(open)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{t('settings.piarium.extensions.workbench.createProfile')}</DialogTitle></DialogHeader>
          <Input
            autoFocus
            value={profileName}
            onChange={(event) => setProfileName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void createProfile(); }}
            placeholder={t('settings.piarium.extensions.workbench.profileName')}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={profileBusy} onClick={() => setCreateOpen(false)}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button type="button" disabled={profileBusy || !profileName.trim()} onClick={() => { void createProfile(); }}>
              {t('settings.piarium.extensions.workbench.createProfile')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={removeOpen} onOpenChange={(open) => !profileBusy && setRemoveOpen(open)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{t('settings.piarium.extensions.workbench.removeProfileNamed', { name: profile.label })}</DialogTitle></DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={profileBusy} onClick={() => setRemoveOpen(false)}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={profileBusy}
              onClick={() => {
                setProfileBusy(true);
                void removeWorkbenchProfile(profile.id).then(() => setRemoveOpen(false)).catch((error) => {
                  toast.error(error instanceof Error ? error.message : String(error));
                }).finally(() => setProfileBusy(false));
              }}
            >
              {t('settings.piarium.extensions.workbench.removeProfile')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  hostState: PiariumExtensionHostStateSnapshot | null;
  surface: ReturnType<typeof useSurfaceRegistrySnapshot>;
}> = ({ busy, entry, hostState, surface }) => {
  const { t } = useI18n();
  const [inspectOpen, setInspectOpen] = React.useState(false);
  const [removeOpen, setRemoveOpen] = React.useState(false);
  const [deleteData, setDeleteData] = React.useState(false);
  const status = actualStatus(entry);
  const candidate = entry.candidate;
  const selectedCapabilities: PiariumExtensionCapabilityReference[] = (["host", "surface"] as const).flatMap((realm) => (
    (entry.manifest.capabilities?.[realm] ?? []).map((capability) => ({ capability, realm }))
  ));
  const selectedDecisions = new Map(entry.capabilityGrants
    .filter((grant) => grant.manifestVersion === entry.manifest.version)
    .map((grant) => [capabilityKey(grant), grant.granted]));
  const selectedCapabilitiesReviewed = entry.source.kind === 'builtin'
    || selectedCapabilities.every((reference) => selectedDecisions.has(capabilityKey(reference)));
  const liveContributions = surface.contributions.filter((item) => item.owner.extensionId === entry.manifest.id);
  const liveSurfaceServices = surface.services.filter((item) => item.owner.extensionId === entry.manifest.id);
  const liveHostServices = hostState?.services.providers.filter((item) => item.extensionId === entry.manifest.id) ?? [];
  const catalogDiagnostics = hostState?.catalog.diagnostics.filter((item) => item.extensionId === entry.manifest.id) ?? [];
  const decisions = new Map(candidate?.capabilityGrants.map((grant) => [capabilityKey(grant), grant.granted]) ?? []);
  const review = async (reference: PiariumExtensionCapabilityReference, granted: boolean): Promise<void> => {
    if (!candidate) return;
    await reviewPiariumExtensionCandidateCapabilities({
      candidateIntegrity: candidate.integrity,
      decisions: [{ ...reference, granted }],
      extensionId: entry.manifest.id,
    });
  };
  const reviewSelected = async (reference: PiariumExtensionCapabilityReference, granted: boolean): Promise<void> => {
    await reviewPiariumExtensionCapabilities({
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
          disabled={busy || (!entry.desired.enabled && !selectedCapabilitiesReviewed)}
          onCheckedChange={(enabled) => {
            void setPiariumExtensionEnabled(entry.manifest.id, enabled).catch(() => undefined);
          }}
          aria-label={t('settings.piarium.extensions.actions.activationAria', {
            name: entry.manifest.displayName ?? entry.manifest.id,
          })}
        />
      </div>

      {entry.source.kind !== 'builtin' && !entry.desired.enabled && selectedCapabilities.length > 0 ? (
        <div className="mt-3 border-t border-border/50 pt-3">
          <div className="mb-2 typography-ui-label text-foreground">
            {t('settings.piarium.extensions.inspector.capabilities')}
          </div>
          <div className="space-y-2">
            {selectedCapabilities.map((reference) => {
              const key = capabilityKey(reference);
              const decision = selectedDecisions.get(key);
              return (
                <div key={key} className="flex flex-col gap-2 rounded-md bg-interactive-hover px-2.5 py-2 @xl:flex-row @xl:items-center @xl:justify-between">
                  <code className="break-all typography-micro">{key}</code>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      type="button"
                      variant={decision === false ? 'secondary' : 'outline'}
                      size="xs"
                      disabled={busy}
                      onClick={() => { void reviewSelected(reference, false).catch(() => undefined); }}
                    >
                      {t('settings.piarium.extensions.candidate.deny')}
                    </Button>
                    <Button
                      type="button"
                      variant={decision === true ? 'secondary' : 'outline'}
                      size="xs"
                      disabled={busy}
                      onClick={() => { void reviewSelected(reference, true).catch(() => undefined); }}
                    >
                      {t('settings.piarium.extensions.candidate.allow')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

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
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => {
                void discardPiariumExtensionCandidate(entry.manifest.id, candidate.integrity).catch(() => undefined);
              }}
            >
              {t('settings.piarium.extensions.candidate.discard')}
            </Button>
            <Button
              type="button"
              size="xs"
              disabled={busy || !candidate.capabilitiesReviewed || candidate.applyRequested}
              onClick={() => {
                void selectPiariumExtensionCandidate(entry.manifest.id, candidate.integrity).catch(() => undefined);
              }}
            >
              {t('settings.piarium.extensions.candidate.apply')}
            </Button>
          </div>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-border/50 pt-3">
        {entry.source.kind === 'local' ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={() => { void reloadPiariumExtensionLocalSource(entry.manifest.id).catch(() => undefined); }}
          >
            {t('settings.piarium.extensions.actions.reloadLocal')}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="xs" onClick={() => setInspectOpen(true)}>
          {t('settings.piarium.extensions.actions.inspect')}
        </Button>
        {entry.source.kind !== 'builtin' ? (
          <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => {
            setDeleteData(false);
            setRemoveOpen(true);
          }}>
            {t('settings.piarium.extensions.actions.remove')}
          </Button>
        ) : null}
      </div>

      <Dialog open={inspectOpen} onOpenChange={setInspectOpen}>
        <DialogContent className="max-h-[min(80vh,48rem)] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{entry.manifest.displayName ?? entry.manifest.id}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 @xl:grid-cols-2">
            <div className="space-y-2">
              <div className="typography-ui-label text-foreground">{t('settings.piarium.extensions.inspector.runtime')}</div>
              <div className="space-y-1 typography-micro text-muted-foreground">
                <div>{t('settings.piarium.extensions.inspector.version')}: {entry.selectedVersion}</div>
                <div>{t('settings.piarium.extensions.inspector.source')}: {entry.source.kind} · {entry.source.display}</div>
                <div>{t('settings.piarium.extensions.inspector.integrity')}: {entry.integrity ?? '—'}</div>
              </div>
              {entry.actual.length > 0 ? (
                <div className="space-y-1">
                  {entry.actual.map((actual) => (
                    <div key={`${actual.realmKind}:${actual.realmId}:${actual.entrypointId}`} className="rounded-md bg-interactive-hover px-2.5 py-2 typography-micro">
                      <div className="text-foreground">{actual.realmKind} · {actual.entrypointId} · {t(STATUS_KEYS[actual.status])}</div>
                      <div className="text-muted-foreground">{actual.realmId} · #{actual.generation} · {actual.updatedAt}</div>
                      {actual.diagnostics.map((diagnostic) => (
                        <div key={`${diagnostic.code}:${diagnostic.timestamp}`} className="mt-1 text-[var(--status-warning)]">
                          {diagnostic.message}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ) : <div className="typography-micro text-muted-foreground">{t('settings.piarium.extensions.inspector.noRealms')}</div>}
              {catalogDiagnostics.length > 0 ? (
                <div className="space-y-1">
                  <div className="typography-ui-label text-foreground">{t('settings.piarium.extensions.inspector.diagnostics')}</div>
                  {catalogDiagnostics.map((diagnostic) => (
                    <div key={`${diagnostic.code}:${diagnostic.timestamp}`} className="rounded-md bg-interactive-hover px-2.5 py-2 typography-micro text-muted-foreground">
                      <div className="text-foreground">{diagnostic.code} · {diagnostic.severity}</div>
                      <div>{diagnostic.message}</div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="space-y-3">
              <div>
                <div className="typography-ui-label text-foreground">{t('settings.piarium.extensions.inspector.artifacts')}</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {entry.manifest.entrypoints?.host ? (
                    <code className="rounded bg-interactive-hover px-1.5 py-1 typography-micro">host · {entry.manifest.entrypoints.host.mode} · {entry.manifest.entrypoints.host.file}</code>
                  ) : null}
                  {(entry.manifest.entrypoints?.surfaces ?? []).map((surface) => (
                    <code key={surface.id} className="rounded bg-interactive-hover px-1.5 py-1 typography-micro">
                      {surface.id} · {surface.mode}{surface.file ? ` · ${surface.file}` : ''}
                    </code>
                  ))}
                  {!entry.manifest.entrypoints?.host && (entry.manifest.entrypoints?.surfaces ?? []).length === 0 ? '—' : null}
                </div>
              </div>
              <div>
                <div className="typography-ui-label text-foreground">{t('settings.piarium.extensions.inspector.contributions')}</div>
                <div className="mt-1 space-y-1">
                  {(entry.manifest.contributions ?? []).map((contribution) => (
                    <div key={contribution.id} className="break-all typography-micro text-muted-foreground">
                      {contribution.title ?? contribution.id} · {contribution.kind} · {liveContributions.some((item) => item.descriptor.id === contribution.id)
                        ? t('settings.piarium.extensions.status.active')
                        : t('settings.piarium.extensions.status.inactive')}
                    </div>
                  ))}
                  {liveContributions.filter((item) => !(entry.manifest.contributions ?? []).some((declared) => declared.id === item.descriptor.id)).map((item) => (
                    <div key={item.descriptor.id} className="break-all typography-micro text-muted-foreground">
                      {item.descriptor.title ?? item.descriptor.id} · {item.descriptor.kind} · {t('settings.piarium.extensions.status.active')}
                    </div>
                  ))}
                  {(entry.manifest.contributions ?? []).length === 0 && liveContributions.length === 0 ? <span className="typography-micro text-muted-foreground">—</span> : null}
                </div>
              </div>
              <div>
                <div className="typography-ui-label text-foreground">{t('settings.piarium.extensions.inspector.services')}</div>
                <div className="mt-1 space-y-1">
                  {liveHostServices.map((service) => (
                    <div key={service.providerId} className="break-all typography-micro text-muted-foreground">
                      host · {service.descriptor.id}@{service.descriptor.version} · {service.status}
                    </div>
                  ))}
                  {liveSurfaceServices.map((service) => (
                    <div key={`${service.owner.realmId}:${service.descriptor.id}@${service.descriptor.version}`} className="break-all typography-micro text-muted-foreground">
                      surface · {service.descriptor.id}@{service.descriptor.version} · {t('settings.piarium.extensions.status.active')}
                    </div>
                  ))}
                  {liveHostServices.length === 0 && liveSurfaceServices.length === 0 ? <span className="typography-micro text-muted-foreground">—</span> : null}
                </div>
              </div>
              <div>
                <div className="typography-ui-label text-foreground">{t('settings.piarium.extensions.inspector.dependencies')}</div>
                <div className="mt-1 space-y-1">
                  {(entry.manifest.requires?.services ?? []).map((service) => (
                    <div key={`${service.id}@${service.version}`} className="break-all typography-micro text-muted-foreground">
                      {service.id}@{service.version}{service.optional ? ` · ${t('settings.piarium.extensions.inspector.optional')}` : ''}
                    </div>
                  ))}
                  {(entry.manifest.integrates?.piPackages ?? []).map((packageName) => (
                    <div key={packageName} className="break-all typography-micro text-muted-foreground">Pi · {packageName}</div>
                  ))}
                  {(entry.manifest.requires?.services ?? []).length === 0 && (entry.manifest.integrates?.piPackages ?? []).length === 0
                    ? <span className="typography-micro text-muted-foreground">—</span>
                    : null}
                </div>
              </div>
              <div>
                <div className="typography-ui-label text-foreground">{t('settings.piarium.extensions.inspector.capabilities')}</div>
                <div className="mt-1 space-y-1">
                  {entry.capabilityGrants.map((grant) => (
                    <div key={`${grant.realm}:${grant.capability}`} className="break-all typography-micro text-muted-foreground">
                      {grant.realm}:{grant.capability} · {grant.granted
                        ? t('settings.piarium.extensions.candidate.allow')
                        : t('settings.piarium.extensions.candidate.deny')}
                    </div>
                  ))}
                  {entry.capabilityGrants.length === 0 ? <span className="typography-micro text-muted-foreground">—</span> : null}
                </div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={removeOpen} onOpenChange={(open) => {
        if (busy) return;
        setRemoveOpen(open);
        if (!open) setDeleteData(false);
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.piarium.extensions.remove.title', {
              name: entry.manifest.displayName ?? entry.manifest.id,
            })}</DialogTitle>
            <DialogDescription>{t('settings.piarium.extensions.remove.storageScope')}</DialogDescription>
          </DialogHeader>
          <SettingsRadioGroup aria-label={t('settings.piarium.extensions.remove.dataChoice')}>
            <SettingsRadioOption
              selected={!deleteData}
              onSelect={() => setDeleteData(false)}
              label={t('settings.piarium.extensions.remove.retainData')}
              description={t('settings.piarium.extensions.remove.retainDataDescription')}
              ariaLabel={t('settings.piarium.extensions.remove.retainData')}
              disabled={busy}
            />
            <SettingsRadioOption
              selected={deleteData}
              onSelect={() => setDeleteData(true)}
              label={t('settings.piarium.extensions.remove.deleteData')}
              description={t('settings.piarium.extensions.remove.deleteDataDescription')}
              ariaLabel={t('settings.piarium.extensions.remove.deleteData')}
              disabled={busy}
            />
          </SettingsRadioGroup>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setRemoveOpen(false)}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                void removePiariumExtension(entry.manifest.id, deleteData).then(() => setRemoveOpen(false)).catch(() => undefined);
              }}
            >
              {t('settings.piarium.extensions.actions.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

const ExtensionInstallSection: React.FC = () => {
  const { t } = useI18n();
  const state = usePiariumExtensionCatalog();
  const [kind, setKind] = React.useState<'git' | 'local' | 'npm'>('npm');
  const [specifier, setSpecifier] = React.useState('');
  const install = async (): Promise<void> => {
    const normalized = specifier.trim();
    if (!normalized) return;
    try {
      await installPiariumExtension({ display: normalized, kind, specifier: normalized });
      setSpecifier('');
    } catch {
      // The catalog store owns the visible error state.
    }
  };
  return (
    <SettingsSection title={t('settings.piarium.extensions.install.title')} settingsItem="extensions.install">
      <div className="grid gap-2 @xl:grid-cols-[11rem_minmax(0,1fr)_auto]">
        <Select value={kind} onValueChange={(value) => setKind(value === 'git' || value === 'local' ? value : 'npm')}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="npm">npm</SelectItem>
            <SelectItem value="git">Git</SelectItem>
            <SelectItem value="local">{t('settings.piarium.extensions.install.local')}</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={specifier}
          onChange={(event) => setSpecifier(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void install(); }}
          placeholder={t('settings.piarium.extensions.install.placeholder')}
        />
        <Button
          type="button"
          disabled={!specifier.trim() || state.busyExtensionId === '__install__'}
          onClick={() => { void install(); }}
        >
          {state.busyExtensionId === '__install__' ? <Icon name="loader-4" className="size-4 animate-spin" /> : null}
          {t('settings.piarium.extensions.install.action')}
        </Button>
      </div>
    </SettingsSection>
  );
};

export const ExtensionsPage: React.FC = () => {
  const { t } = useI18n();
  const state = usePiariumExtensionCatalog();
  const surface = useSurfaceRegistrySnapshot();
  const extensions = state.snapshot?.catalog.extensions ?? [];
  const hostDiagnostics = [
    ...(state.snapshot?.catalog.diagnostics ?? []),
    ...(state.snapshot?.routing.diagnostics ?? []),
    ...(state.snapshot?.workbench.diagnostics ?? []),
  ];
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
        {hostDiagnostics.map((diagnostic, index) => (
          <div
            key={`${diagnostic.code}:${diagnostic.timestamp}:${diagnostic.message}:${index}`}
            className={diagnostic.severity === 'error'
              ? 'mb-3 rounded-lg border border-[color-mix(in_srgb,var(--status-error)_24%,transparent)] bg-[color-mix(in_srgb,var(--status-error)_7%,transparent)] px-3 py-2 typography-meta text-[var(--status-error)]'
              : 'mb-3 rounded-lg border border-[color-mix(in_srgb,var(--status-warning)_24%,transparent)] bg-[color-mix(in_srgb,var(--status-warning)_7%,transparent)] px-3 py-2 typography-meta text-[var(--status-warning)]'}
          >
            <span className="font-medium">{diagnostic.code}</span> · {diagnostic.message}
          </div>
        ))}
        <div className="space-y-2">
          {extensions.map((entry) => (
            <ExtensionCard
              key={entry.manifest.id}
              entry={entry}
              hostState={state.snapshot}
              surface={surface}
              busy={state.busyExtensionId === entry.manifest.id}
            />
          ))}
        </div>
        {state.snapshot?.catalog.authoritative && extensions.length === 0 && !state.loading ? (
          <div className="rounded-lg border border-dashed border-border/60 px-4 py-8 text-center typography-ui text-muted-foreground">
            {t('settings.piarium.extensions.empty')}
          </div>
        ) : null}
      </SettingsSection>
      <ExtensionInstallSection />
      <ServiceRoutingSection />
      <WorkbenchProfileSection />
    </SettingsPageLayout>
  );
};
