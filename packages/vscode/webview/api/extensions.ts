import {
  parsePiariumExtensionAssetPayload,
  parsePiariumExtensionCatalogAvailability,
  parsePiariumExtensionCatalogSnapshot,
  parsePiariumExtensionCandidatePreparationResult,
  parsePiariumExtensionHostStateSnapshot,
  parsePiariumExtensionLocalSourceReloadResult,
  parsePiariumExtensionManagedEntrypointPayload,
  parsePiariumExtensionServiceRoutingSnapshot,
  parsePiariumWorkbenchProfileSnapshot,
} from '@piarium/extension-contract';
import type { ExtensionsAPI } from '@piarium/ui/lib/api/types';
import { getVSCodeAPI, sendBridgeMessage, sendBridgeMessageWithOptions } from './bridge';

export const createVSCodeExtensionsAPI = (): ExtensionsAPI => ({
  activateExtension: async (extensionId) => {
    await sendBridgeMessage('api:extensions:activate', { extensionId });
  },
  applyWorkbenchProfile: async (request) => parsePiariumExtensionCatalogSnapshot(
    await sendBridgeMessage('api:extensions:workbench:profile:apply', request),
  ),
  catalog: async () => parsePiariumExtensionCatalogAvailability(
    await sendBridgeMessage('api:extensions:catalog'),
  ),
  discardPreparedCandidate: async (extensionId, candidateIntegrity) => {
    await sendBridgeMessage('api:extensions:candidate:discard-prepared', { candidateIntegrity, extensionId });
  },
  discardCandidate: async (request) => parsePiariumExtensionCatalogSnapshot(
    await sendBridgeMessage('api:extensions:candidate:discard', request),
  ),
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
  requestCandidateApplication: async (request) => parsePiariumExtensionCatalogSnapshot(
    await sendBridgeMessage('api:extensions:candidate:request-application', request),
  ),
  readAsset: async (request) => parsePiariumExtensionAssetPayload(
    await sendBridgeMessage('api:extensions:asset', request),
  ),
  readManagedEntrypoint: async (request) => parsePiariumExtensionManagedEntrypointPayload(
    await sendBridgeMessage('api:extensions:entrypoint', request),
  ),
  reloadLocalSource: async (request) => parsePiariumExtensionLocalSourceReloadResult(
    await sendBridgeMessage('api:extensions:reload-local-source', request),
  ),
  reportActualState: async (extensionId, state) => {
    await sendBridgeMessage('api:extensions:actual', { extensionId, state });
  },
  reviewCapabilities: async (request) => parsePiariumExtensionCatalogSnapshot(
    await sendBridgeMessage('api:extensions:review-capabilities', request),
  ),
  reviewCandidateCapabilities: async (request) => parsePiariumExtensionCatalogSnapshot(
    await sendBridgeMessage('api:extensions:candidate:review-capabilities', request),
  ),
  selectCandidate: async (request) => parsePiariumExtensionCatalogSnapshot(
    await sendBridgeMessage('api:extensions:candidate:select', request),
  ),
  setEnabled: async (extensionId, enabled, expectedRevision) => parsePiariumExtensionCatalogSnapshot(
    await sendBridgeMessage('api:extensions:set-enabled', { enabled, expectedRevision, extensionId }),
  ),
  setServiceSelection: async (request) => parsePiariumExtensionHostStateSnapshot(
    await sendBridgeMessage('api:extensions:service:select', request),
  ),
  upsertServiceRoutingRule: async (request) => parsePiariumExtensionServiceRoutingSnapshot(
    await sendBridgeMessage('api:extensions:service:routing:upsert', request),
  ),
  removeServiceRoutingRule: async (request) => parsePiariumExtensionServiceRoutingSnapshot(
    await sendBridgeMessage('api:extensions:service:routing:remove', request),
  ),
  removeExtension: async (request) => parsePiariumExtensionCatalogSnapshot(
    await sendBridgeMessage('api:extensions:remove', request),
  ),
  updateWorkbenchLayout: async (request) => parsePiariumWorkbenchProfileSnapshot(
    await sendBridgeMessage('api:extensions:workbench:layout', request),
  ),
  selectWorkbenchProfile: async (request) => parsePiariumWorkbenchProfileSnapshot(
    await sendBridgeMessage('api:extensions:workbench:profile:select', request),
  ),
  upsertWorkbenchProfile: async (request) => parsePiariumWorkbenchProfileSnapshot(
    await sendBridgeMessage('api:extensions:workbench:profile:upsert', request),
  ),
  removeWorkbenchProfile: async (request) => parsePiariumWorkbenchProfileSnapshot(
    await sendBridgeMessage('api:extensions:workbench:profile:remove', request),
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
