import {
  parsePiariumExtensionAssetPayload,
  parsePiariumExtensionCatalogAvailability,
  parsePiariumExtensionCatalogSnapshot,
  parsePiariumExtensionManagedEntrypointPayload,
} from '@piarium/extension-contract';
import type { ExtensionsAPI } from '@piarium/ui/lib/api/types';
import { sendBridgeMessage } from './bridge';

export const createVSCodeExtensionsAPI = (): ExtensionsAPI => ({
  catalog: async () => parsePiariumExtensionCatalogAvailability(
    await sendBridgeMessage('api:extensions:catalog'),
  ),
  install: async (request) => parsePiariumExtensionCatalogSnapshot(
    await sendBridgeMessage('api:extensions:install', request),
  ),
  readAsset: async (request) => parsePiariumExtensionAssetPayload(
    await sendBridgeMessage('api:extensions:asset', request),
  ),
  readManagedEntrypoint: async (request) => parsePiariumExtensionManagedEntrypointPayload(
    await sendBridgeMessage('api:extensions:entrypoint', request),
  ),
  reportActualState: async (extensionId, state) => {
    await sendBridgeMessage('api:extensions:actual', { extensionId, state });
  },
  selectCandidate: async (request) => parsePiariumExtensionCatalogSnapshot(
    await sendBridgeMessage('api:extensions:candidate:select', request),
  ),
});
