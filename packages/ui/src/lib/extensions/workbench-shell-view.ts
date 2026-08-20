import type {
  PiariumApplicationSurface,
  PiariumExtensionHostStateSnapshot,
  PiariumWorkbenchResolvedProfile,
} from '@piarium/extension-contract';
import { inspectPiariumWorkbenchShell, resolvePiariumWorkbenchProfile } from '@piarium/extension-contract';
import type { SurfaceRegistrySnapshot } from '@piarium/extension-surface';

type WorkbenchShellView = 'loading' | 'ready' | 'recovery';

export const resolveWorkbenchShellView = (
  snapshot: PiariumExtensionHostStateSnapshot | null | undefined,
  surface: PiariumApplicationSurface,
  workspaceId?: string,
  surfaceSnapshot?: SurfaceRegistrySnapshot,
): { resolved: PiariumWorkbenchResolvedProfile | null; view: WorkbenchShellView } => {
  const workbench = snapshot?.workbench;
  if (!snapshot || !workbench?.authoritative) {
    return { resolved: null, view: 'loading' };
  }
  let resolved = resolvePiariumWorkbenchProfile(workbench.document, snapshot.catalog, {
    surface,
    userId: 'default',
    ...(workspaceId ? { workspaceId } : {}),
  });
  if (surfaceSnapshot) {
    const inspected = inspectPiariumWorkbenchShell(
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
