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
import { workbenchProfileLabel } from '@/lib/extensions/workbench-profile-label';
import { selectActiveWorkbenchProfile } from '@/lib/extensions/workbench-shell-transition';
import { useWorkbenchWorkspaceId } from '@/lib/extensions/workbench-workspace';
import { piariumSurfaceRuntime } from '@/lib/extensions/surface-runtime';
import { resolvePiariumWorkbenchLayout } from '@piarium/extension-contract';

export const WorkbenchProfileSwitcher: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useI18n();
  const catalog = usePiariumExtensionCatalog();
  const workspaceId = useWorkbenchWorkspaceId();
  const [busy, setBusy] = React.useState(false);
  const workbench = catalog.snapshot?.workbench;

  if (!workbench?.authoritative) return null;
  const resolved = resolvePiariumWorkbenchLayout(workbench.document, {
    surface: piariumSurfaceRuntime.surface,
    userId: 'default',
    ...(workspaceId ? { workspaceId } : {}),
  });
  const activeProfile = workbench.document.profiles.find((profile) => profile.id === resolved.profileId);
  if (!activeProfile || workbench.document.profiles.length < 2) return null;

  const switchProfile = async (profileId: string): Promise<void> => {
    if (profileId === resolved.profileId || busy) return;
    setBusy(true);
    try {
      await selectActiveWorkbenchProfile(profileId, workspaceId, { enableShell: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          aria-busy={busy}
          aria-label={t('workbench.recovery.chooseProfile')}
          className={cn('app-region-no-drag min-w-0 max-w-40 gap-1.5 px-2', className)}
        >
          <Icon name="layout-column" className="size-4 shrink-0" />
          <span className="truncate">{workbenchProfileLabel(activeProfile, t)}</span>
          <Icon name="arrow-down-s" className="size-4 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-40">
        <DropdownMenuRadioGroup
          value={resolved.profileId}
          onValueChange={(profileId) => {
            void switchProfile(profileId);
          }}
        >
          {workbench.document.profiles.map((profile) => (
            <DropdownMenuRadioItem key={profile.id} value={profile.id} disabled={busy}>
              {workbenchProfileLabel(profile, t)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
