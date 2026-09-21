import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { usePiariumExtensionCatalog } from '@/lib/extensions/catalog-store';
import { workbenchWorkspaceLabel } from '@/lib/extensions/workbench-profile-label';
import { selectActiveWorkbenchProfile } from '@/lib/extensions/workbench-shell-transition';
import { piariumSurfaceRuntime } from '@/lib/extensions/surface-runtime';
import { useUIStore } from '@/stores/useUIStore';
import {
  PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID,
  PIARIUM_WORKBENCH_IDE_PROFILE_ID,
  PIARIUM_WORKBENCH_RESEARCH_PROFILE_ID,
  resolvePiariumWorkbenchLayout,
} from '@piarium/extension-contract';
import {
  getWorkbenchProfileTransitionSnapshot,
  subscribeWorkbenchProfileTransition,
} from '@/lib/workbench/profile-transition';

export const WorkbenchProfileSwitcher: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useI18n();
  const catalog = usePiariumExtensionCatalog();
  const [pending, setPending] = React.useState(false);
  const workbench = catalog.snapshot?.workbench;
  const hostId = workbench?.hostId;
  const rememberedProfileId = useUIStore((state) => hostId ? state.agentWorkbenchProfileByHost[hostId] : undefined);
  const rememberProfile = useUIStore((state) => state.rememberAgentWorkbenchProfile);
  const transition = React.useSyncExternalStore(
    subscribeWorkbenchProfileTransition,
    getWorkbenchProfileTransitionSnapshot,
    getWorkbenchProfileTransitionSnapshot,
  );
  const busy = pending || transition.phase !== 'idle';
  const resolved = workbench?.authoritative ? resolvePiariumWorkbenchLayout(workbench.document, {
    surface: piariumSurfaceRuntime.surface,
    userId: 'default',
  }) : null;
  const activeProfileId = resolved?.profileId;
  const isIde = activeProfileId === PIARIUM_WORKBENCH_IDE_PROFILE_ID;

  // Remember committed Agent workspaces across shell remounts and app restarts. This is
  // only the IDE return destination; the Host profile remains the active-shell authority.
  React.useEffect(() => {
    if (hostId && activeProfileId && !isIde) rememberProfile(hostId, activeProfileId);
  }, [hostId, activeProfileId, isIde, rememberProfile]);

  if (!workbench?.authoritative || !resolved || !hostId) return null;
  const agentProfiles = workbench.document.profiles.filter((profile) => profile.id !== PIARIUM_WORKBENCH_IDE_PROFILE_ID);
  const agentProfile = agentProfiles.find((profile) => profile.id === (isIde ? rememberedProfileId : activeProfileId))
    ?? agentProfiles.find((profile) => profile.id === PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID)
    ?? agentProfiles[0];
  if (!agentProfile) return null;
  const hasIde = workbench.document.profiles.some((profile) => profile.id === PIARIUM_WORKBENCH_IDE_PROFILE_ID);

  const switchProfile = async (profileId: string): Promise<void> => {
    if (profileId === resolved.profileId || busy) return;
    setPending(true);
    try {
      await selectActiveWorkbenchProfile(profileId, undefined, { enableShell: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="app-region-no-drag flex min-w-0 items-center gap-1.5" aria-busy={busy}>
      {hasIde ? (
        <div role="group" aria-label={t('workbench.switcher.presentation')} className={cn('flex shrink-0 items-center rounded-md bg-interactive-hover p-0.5', className)}>
          {([
            { id: 'agent', label: t('settings.piarium.extensions.workbench.profile.agent'), selected: !isIde, profileId: agentProfile.id },
            { id: 'ide', label: t('settings.piarium.extensions.workbench.profile.ide'), selected: isIde, profileId: PIARIUM_WORKBENCH_IDE_PROFILE_ID },
          ]).map((view) => (
            <button
              key={view.id}
              type="button"
              aria-pressed={view.selected}
              disabled={busy}
              onClick={() => { void switchProfile(view.profileId); }}
              className={cn(
                'h-6 rounded px-2 typography-meta font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50',
                view.selected ? 'bg-interactive-selection text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {view.label}
            </button>
          ))}
        </div>
      ) : null}
      {agentProfiles.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              aria-busy={busy}
              aria-label={`${t('workbench.switcher.workspace')}: ${workbenchWorkspaceLabel(agentProfile, t)}`}
              className="h-7 min-w-0 max-w-40 gap-1 px-1.5"
            >
              <Icon name={agentProfile.id === PIARIUM_WORKBENCH_RESEARCH_PROFILE_ID ? 'flask' : 'layout-column'} className="size-3.5 shrink-0" />
              <span className="truncate">{workbenchWorkspaceLabel(agentProfile, t)}</span>
              <Icon name="arrow-down-s" className="size-4 shrink-0 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-40">
            <DropdownMenuRadioGroup
              value={agentProfile.id}
              onValueChange={(profileId) => {
                if (busy) return;
                if (isIde) rememberProfile(hostId, profileId);
                else void switchProfile(profileId);
              }}
            >
              {agentProfiles.map((profile) => (
                <DropdownMenuRadioItem key={profile.id} value={profile.id} disabled={busy}>
                  {workbenchWorkspaceLabel(profile, t)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
};
