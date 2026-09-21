import React from 'react';
import {
  VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
  VARIN_CORE_SERVICE_VERSION,
  VARIN_WORKBENCH_LAYOUT_SERVICE_ID,
} from '@varin/extension-contract';
import { useVarinExtensionCatalog } from '@/lib/extensions/catalog-store';
import {
  peekIdeWorkbenchLayout,
  setIdeWorkbenchLayoutProvider,
  subscribeIdeWorkbenchLayout,
  type IdeWorkbenchLayoutState,
} from './ide-layout';

export const useIdeWorkbenchLayout = (workspaceId: string | undefined): IdeWorkbenchLayoutState | undefined => {
  const catalog = useVarinExtensionCatalog();
  const activeProvider = catalog.snapshot?.services.providers.find((item) => (
    item.status === 'active'
    && item.extensionId === VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION_ID
    && item.descriptor.id === VARIN_WORKBENCH_LAYOUT_SERVICE_ID
    && item.descriptor.version === VARIN_CORE_SERVICE_VERSION
  ));
  const providerSignature = activeProvider
    ? `${catalog.snapshot?.catalog.hostId ?? ''}\0${activeProvider.providerId}\0${activeProvider.generation}`
    : '';
  const state = React.useSyncExternalStore(
    subscribeIdeWorkbenchLayout,
    () => peekIdeWorkbenchLayout(workspaceId),
    () => undefined,
  );
  React.useEffect(() => {
    if (!workspaceId) return;
    setIdeWorkbenchLayoutProvider(
      workspaceId,
      activeProvider ? { providerId: activeProvider.providerId, signature: providerSignature } : null,
      Boolean(catalog.snapshot?.services),
    );
  }, [activeProvider, catalog.snapshot?.services, providerSignature, workspaceId]);
  return state;
};
