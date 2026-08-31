// Re-export from @piarium/application-client for backward compatibility.
// The canonical implementation lives in application-client/src/transport/.
export {
  buildRuntimeAuthHeaders,
  clearRuntimeAuthCredentialProvider,
  clearRuntimeUrlAuthToken,
  acquireRuntimeUrlAuthToken,
  getLocalRuntimeUrlAuthTokenSync,
  getRuntimeBearerTokenSync,
  getRuntimeExtraHeadersSync,
  getRuntimeUrlAuthTokenSync,
  refreshLocalRuntimeUrlAuthToken,
  refreshRuntimeUrlAuthToken,
  setLocalRuntimeUrlAuthToken,
  setRuntimeAuthCredentialProvider,
  setRuntimeBearerToken,
  setRuntimeExtraHeaders,
  setRuntimeUrlAuthToken,
  subscribeRuntimeUrlAuthToken,
  type RuntimeAuthCredentialProvider,
} from '@piarium/application-client';
