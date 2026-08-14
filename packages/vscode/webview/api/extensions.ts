import {
  parsePiariumExtensionAssetPayload,
  parsePiariumExtensionCatalogAvailability,
  parsePiariumExtensionCatalogSnapshot,
  parsePiariumExtensionCandidatePreparationResult,
  parsePiariumExtensionHostStateSnapshot,
  parsePiariumExtensionManagedEntrypointPayload,
} from '@piarium/extension-contract';
import type { ExtensionsAPI } from '@piarium/ui/lib/api/types';
import { getVSCodeAPI, sendBridgeMessage, sendBridgeMessageWithOptions } from './bridge';

export const createVSCodeExtensionsAPI = (): ExtensionsAPI => ({
  activateExtension: async (extensionId) => {
    await sendBridgeMessage('api:extensions:activate', { extensionId });
  },
  catalog: async () => parsePiariumExtensionCatalogAvailability(
    await sendBridgeMessage('api:extensions:catalog'),
  ),
  discardPreparedCandidate: async (extensionId, candidateIntegrity) => {
    await sendBridgeMessage('api:extensions:candidate:discard-prepared', { candidateIntegrity, extensionId });
  },
  hostState: async () => parsePiariumExtensionHostStateSnapshot(
    await sendBridgeMessage('api:extensions:host-state'),
  ),
  install: async (request) => parsePiariumExtensionCatalogSnapshot(
    await sendBridgeMessage('api:extensions:install', request),
  ),
  invokeService: async (request) => await sendBridgeMessage('api:extensions:service:invoke', request),
  prepareCandidate: async (extensionId, candidateIntegrity) => {
    return parsePiariumExtensionCandidatePreparationResult(
      await sendBridgeMessage('api:extensions:candidate:prepare', { candidateIntegrity, extensionId }),
    );
  },
  readAsset: async (request) => parsePiariumExtensionAssetPayload(
    await sendBridgeMessage('api:extensions:asset', request),
  ),
  readManagedEntrypoint: async (request) => parsePiariumExtensionManagedEntrypointPayload(
    await sendBridgeMessage('api:extensions:entrypoint', request),
  ),
  reportActualState: async (extensionId, state) => {
    await sendBridgeMessage('api:extensions:actual', { extensionId, state });
  },
  reviewCandidateCapabilities: async (request) => parsePiariumExtensionCatalogSnapshot(
    await sendBridgeMessage('api:extensions:candidate:review-capabilities', request),
  ),
  selectCandidate: async (request) => parsePiariumExtensionCatalogSnapshot(
    await sendBridgeMessage('api:extensions:candidate:select', request),
  ),
  setServiceSelection: async (request) => parsePiariumExtensionHostStateSnapshot(
    await sendBridgeMessage('api:extensions:service:select', request),
  ),
  waitForHostState: async (request, signal) => parsePiariumExtensionHostStateSnapshot(
    await sendBridgeMessageWithOptions('api:extensions:host-state:wait', request, {
      signal,
      timeoutMs: Number.POSITIVE_INFINITY,
      onAbort: (requestId) => getVSCodeAPI().postMessage({
        id: `cancel_${requestId}`,
        payload: { requestId },
        type: 'api:extensions:host-state:wait:cancel',
      }),
    }),
  ),
});
