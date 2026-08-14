import {
  parsePiariumExtensionCatalogAvailability,
  parsePiariumExtensionAssetPayload,
  parsePiariumExtensionCatalogSnapshot,
  parsePiariumExtensionCandidatePreparationResult,
  parsePiariumExtensionHostStateSnapshot,
  parsePiariumExtensionManagedEntrypointPayload,
  parsePiariumExtensionServiceRoutingSnapshot,
  parsePiariumWorkbenchProfileSnapshot,
  type PiariumExtensionActualState,
  type PiariumExtensionAssetRequest,
  type PiariumExtensionCandidateCapabilityReviewRequest,
  type PiariumExtensionCandidateSelectionRequest,
  type PiariumExtensionCatalogAvailability,
  type PiariumExtensionManagedEntrypointRequest,
  type PiariumExtensionPackageInstallRequest,
  type PiariumExtensionHostStateWaitRequest,
} from '@piarium/extension-contract';
import type { ExtensionsAPI } from '@piarium/ui/lib/api/types';
import { refreshLocalRuntimeUrlAuthToken } from '@piarium/ui/lib/runtime-auth';
import { fetchWithoutRuntimeRouting } from '@piarium/ui/lib/runtime-fetch';

const normalizeOrigin = (value: string): string => value.trim().replace(/\/+$/, '');

const applicationHostOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  const injected = typeof window.__PIARIUM_LOCAL_ORIGIN__ === 'string'
    ? normalizeOrigin(window.__PIARIUM_LOCAL_ORIGIN__)
    : '';
  return injected || normalizeOrigin(window.location.origin);
};

const currentOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  return normalizeOrigin(window.location.origin);
};

const errorResult = (message: string, retryable: boolean): PiariumExtensionCatalogAvailability => ({
  supported: true,
  status: 'error',
  error: { code: 'application_host_unavailable', message, retryable },
});

const applicationHostRequest = async (
  path: string,
  body: unknown,
  signal?: AbortSignal,
  method = 'POST',
): Promise<Response> => {
  const origin = applicationHostOrigin();
  const target = origin ? new URL(path, `${origin}/`) : new URL(path, window.location.href);
  const headers = new Headers({ Accept: 'application/json', 'Content-Type': 'application/json' });
  if (origin && origin !== currentOrigin()) {
    headers.set('X-Piarium-Application-Token', await refreshLocalRuntimeUrlAuthToken(origin));
  }
  return fetchWithoutRuntimeRouting(target, {
    body: JSON.stringify(body),
    credentials: 'include',
    headers,
    method,
    signal,
  });
};

const applicationHostRead = async (path: string): Promise<Response> => {
  const origin = applicationHostOrigin();
  const target = origin ? new URL(path, `${origin}/`) : new URL(path, window.location.href);
  if (origin && origin !== currentOrigin()) {
    target.searchParams.set('piarium_url_token', await refreshLocalRuntimeUrlAuthToken(origin));
  }
  return fetchWithoutRuntimeRouting(target, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
};

const readJsonOrThrow = async (response: Response): Promise<unknown> => {
  const payload = await response.json().catch(() => null) as unknown;
  if (response.ok) return payload;
  const message = payload && typeof payload === 'object' && 'error' in payload
    && typeof (payload as { error?: { message?: unknown } }).error?.message === 'string'
    ? String((payload as { error: { message: string } }).error.message)
    : `Piarium extension host request failed (${response.status})`;
  throw new Error(message);
};

export const createWebExtensionsAPI = (): ExtensionsAPI => ({
  activateExtension: async (extensionId) => {
    const response = await applicationHostRequest(`/api/piarium/extensions/v1/extensions/${encodeURIComponent(extensionId)}/activate`, {});
    if (!response.ok) await readJsonOrThrow(response);
  },
  catalog: async () => {
    try {
      const origin = applicationHostOrigin();
      const target = origin
        ? new URL('/api/piarium/extensions/v1/catalog', `${origin}/`)
        : new URL('/api/piarium/extensions/v1/catalog', window.location.href);
      if (origin && origin !== currentOrigin()) {
        const token = await refreshLocalRuntimeUrlAuthToken(origin);
        target.searchParams.set('piarium_url_token', token);
      }
      const response = await fetchWithoutRuntimeRouting(target, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        try {
          const parsed = parsePiariumExtensionCatalogAvailability(payload);
          if (parsed.supported === true && parsed.status === 'error') return parsed;
        } catch {
          // The HTTP status below remains the authoritative failure when the error body is malformed.
        }
        return errorResult(`Extension catalog request failed (${response.status})`, response.status >= 500);
      }
      return parsePiariumExtensionCatalogAvailability(payload);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error), true);
    }
  },
  discardPreparedCandidate: async (extensionId, candidateIntegrity) => {
    const response = await applicationHostRequest('/api/piarium/extensions/v1/candidates/discard-prepared', { candidateIntegrity, extensionId });
    if (!response.ok) await readJsonOrThrow(response);
  },
  hostState: async () => parsePiariumExtensionHostStateSnapshot(
    await readJsonOrThrow(await applicationHostRead('/api/piarium/extensions/v1/host-state')),
  ),
  install: async (request: PiariumExtensionPackageInstallRequest) => {
    const payload = await readJsonOrThrow(await applicationHostRequest('/api/piarium/extensions/v1/install', request));
    if (!payload || typeof payload !== 'object' || !('snapshot' in payload)) throw new Error('Piarium extension install response is malformed');
    return parsePiariumExtensionCatalogSnapshot((payload as { snapshot: unknown }).snapshot);
  },
  invokeService: async (request) => {
    const payload = await readJsonOrThrow(await applicationHostRequest('/api/piarium/extensions/v1/services/invoke', request));
    if (!payload || typeof payload !== 'object' || !('result' in payload)) throw new Error('Piarium Host service response is malformed');
    return JSON.parse(JSON.stringify((payload as { result: unknown }).result));
  },
  prepareCandidate: async (extensionId, candidateIntegrity) => {
    const response = await applicationHostRequest('/api/piarium/extensions/v1/candidates/prepare', { candidateIntegrity, extensionId });
    return parsePiariumExtensionCandidatePreparationResult(await readJsonOrThrow(response));
  },
  readAsset: async (request: PiariumExtensionAssetRequest) => (
    parsePiariumExtensionAssetPayload(await readJsonOrThrow(
      await applicationHostRequest('/api/piarium/extensions/v1/assets/read', request),
    ))
  ),
  readManagedEntrypoint: async (request: PiariumExtensionManagedEntrypointRequest) => (
    parsePiariumExtensionManagedEntrypointPayload(await readJsonOrThrow(
      await applicationHostRequest('/api/piarium/extensions/v1/entrypoints/read', request),
    ))
  ),
  reportActualState: async (extensionId: string, state: PiariumExtensionActualState) => {
    await readJsonOrThrow(await applicationHostRequest('/api/piarium/extensions/v1/actual', { extensionId, state }))
      .catch((error) => {
        // A successful actual-state report intentionally has no response body.
        if (error instanceof SyntaxError) return undefined;
        throw error;
      });
  },
  reviewCandidateCapabilities: async (request: PiariumExtensionCandidateCapabilityReviewRequest) => {
    const payload = await readJsonOrThrow(await applicationHostRequest('/api/piarium/extensions/v1/candidates/review-capabilities', request));
    if (!payload || typeof payload !== 'object' || !('snapshot' in payload)) throw new Error('Piarium extension capability review response is malformed');
    return parsePiariumExtensionCatalogSnapshot((payload as { snapshot: unknown }).snapshot);
  },
  selectCandidate: async (request: PiariumExtensionCandidateSelectionRequest) => {
    const payload = await readJsonOrThrow(await applicationHostRequest('/api/piarium/extensions/v1/candidates/select', request));
    if (!payload || typeof payload !== 'object' || !('snapshot' in payload)) throw new Error('Piarium extension candidate response is malformed');
    return parsePiariumExtensionCatalogSnapshot((payload as { snapshot: unknown }).snapshot);
  },
  setEnabled: async (extensionId, enabled, expectedRevision) => {
    const payload = await readJsonOrThrow(await applicationHostRequest(
      `/api/piarium/extensions/v1/extensions/${encodeURIComponent(extensionId)}/enabled`,
      { enabled, expectedRevision },
      undefined,
      'PATCH',
    ));
    if (!payload || typeof payload !== 'object' || !('snapshot' in payload)) throw new Error('Piarium extension enabled response is malformed');
    return parsePiariumExtensionCatalogSnapshot((payload as { snapshot: unknown }).snapshot);
  },
  setServiceSelection: async (request) => parsePiariumExtensionHostStateSnapshot(
    await readJsonOrThrow(await applicationHostRequest('/api/piarium/extensions/v1/services/select', request)),
  ),
  upsertServiceRoutingRule: async (request) => parsePiariumExtensionServiceRoutingSnapshot(
    await readJsonOrThrow(await applicationHostRequest('/api/piarium/extensions/v1/services/routing', request, undefined, 'PUT')),
  ),
  removeServiceRoutingRule: async (request) => parsePiariumExtensionServiceRoutingSnapshot(
    await readJsonOrThrow(await applicationHostRequest('/api/piarium/extensions/v1/services/routing/remove', request)),
  ),
  updateWorkbenchLayout: async (request) => parsePiariumWorkbenchProfileSnapshot(
    await readJsonOrThrow(await applicationHostRequest('/api/piarium/extensions/v1/workbench/layout', request, undefined, 'PATCH')),
  ),
  selectWorkbenchProfile: async (request) => parsePiariumWorkbenchProfileSnapshot(
    await readJsonOrThrow(await applicationHostRequest('/api/piarium/extensions/v1/workbench/profile/select', request, undefined, 'PATCH')),
  ),
  upsertWorkbenchProfile: async (request) => parsePiariumWorkbenchProfileSnapshot(
    await readJsonOrThrow(await applicationHostRequest('/api/piarium/extensions/v1/workbench/profiles', request, undefined, 'PUT')),
  ),
  removeWorkbenchProfile: async (request) => parsePiariumWorkbenchProfileSnapshot(
    await readJsonOrThrow(await applicationHostRequest('/api/piarium/extensions/v1/workbench/profiles/remove', request)),
  ),
  waitForHostState: async (request: PiariumExtensionHostStateWaitRequest, signal?: AbortSignal) => (
    parsePiariumExtensionHostStateSnapshot(await readJsonOrThrow(
      await applicationHostRequest('/api/piarium/extensions/v1/host-state/wait', request, signal),
    ))
  ),
});
