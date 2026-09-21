import type {
  VarinApplicationSurface,
  VarinExtensionHostStateSnapshot,
  VarinWorkbenchResolvedProfile,
} from '@varin/extension-contract';
import { inspectVarinWorkbenchShell, resolveVarinWorkbenchProfile } from '@varin/extension-contract';
import type { SurfaceRegistrySnapshot } from '@varin/extension-surface';

type WorkbenchShellView = 'loading' | 'ready' | 'recovery';

export const resolveWorkbenchShellView = (
  snapshot: VarinExtensionHostStateSnapshot | null | undefined,
  surface: VarinApplicationSurface,
  workspaceId?: string,
  surfaceSnapshot?: SurfaceRegistrySnapshot,
): { resolved: VarinWorkbenchResolvedProfile | null; view: WorkbenchShellView } => {
  const workbench = snapshot?.workbench;
  if (!snapshot || !workbench?.authoritative) {
    return { resolved: null, view: 'loading' };
  }
  let resolved = resolveVarinWorkbenchProfile(workbench.document, snapshot.catalog, {
    surface,
    userId: 'default',
    ...(workspaceId ? { workspaceId } : {}),
  });
  if (surfaceSnapshot) {
    const inspected = inspectVarinWorkbenchShell(
      resolved.layout.replacementSelections,
      snapshot.catalog.extensions,
      surface,
      {
        hostId: snapshot.catalog.hostId,
        realmIds: surfaceSnapshot.actual.map((state) => state.realmId),
      },
    );
    resolved = {
      layout: resolved.layout,
      profileId: resolved.profileId,
      status: inspected.status,
      ...(inspected.shellContributionId ? { shellContributionId: inspected.shellContributionId } : {}),
      ...(inspected.shellExtensionId ? { shellExtensionId: inspected.shellExtensionId } : {}),
    };
  }
  return {
    resolved,
    view: resolved.status === 'ready' ? 'ready' : 'recovery',
  };
};
