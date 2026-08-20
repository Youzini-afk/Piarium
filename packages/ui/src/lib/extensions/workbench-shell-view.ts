import type {
  PiariumApplicationSurface,
  PiariumExtensionHostStateSnapshot,
  PiariumWorkbenchResolvedProfile,
} from '@piarium/extension-contract';
import { resolvePiariumWorkbenchProfile } from '@piarium/extension-contract';

type WorkbenchShellView = 'loading' | 'ready' | 'recovery';

export const resolveWorkbenchShellView = (
  snapshot: PiariumExtensionHostStateSnapshot | null | undefined,
  surface: PiariumApplicationSurface,
  workspaceId?: string,
): { resolved: PiariumWorkbenchResolvedProfile | null; view: WorkbenchShellView } => {
  const workbench = snapshot?.workbench;
  if (!snapshot || !workbench?.authoritative) {
    return { resolved: null, view: 'loading' };
  }
  const resolved = resolvePiariumWorkbenchProfile(workbench.document, snapshot.catalog, {
    surface,
    userId: 'default',
    ...(workspaceId ? { workspaceId } : {}),
  });
  return {
    resolved,
    view: resolved.status === 'ready' ? 'ready' : 'recovery',
  };
};
