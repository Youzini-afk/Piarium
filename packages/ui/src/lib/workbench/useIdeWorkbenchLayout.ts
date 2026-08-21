import React from 'react';
import {
  PIARIUM_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
  PIARIUM_CORE_SERVICE_VERSION,
  PIARIUM_WORKBENCH_LAYOUT_SERVICE_ID,
} from '@piarium/extension-contract';
import { usePiariumExtensionCatalog } from '@/lib/extensions/catalog-store';
import {
  peekIdeWorkbenchLayout,
  setIdeWorkbenchLayoutProvider,
  subscribeIdeWorkbenchLayout,
  type IdeWorkbenchLayoutState,
} from './ide-layout';

export const useIdeWorkbenchLayout = (workspaceId: string | undefined): IdeWorkbenchLayoutState | undefined => {
  const catalog = usePiariumExtensionCatalog();
  const activeProvider = catalog.snapshot?.services.providers.find((item) => (
    item.status === 'active'
    && item.extensionId === PIARIUM_BUILTIN_IDE_WORKBENCH_EXTENSION_ID
    && item.descriptor.id === PIARIUM_WORKBENCH_LAYOUT_SERVICE_ID
    && item.descriptor.version === PIARIUM_CORE_SERVICE_VERSION
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
