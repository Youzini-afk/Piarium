// Re-export from @piarium/application-client for backward compatibility.
// The canonical implementation lives in application-client/src/transport/.
export {
  buildRuntimeFetchUrl,
  fetchWithoutRuntimeRouting,
  installRuntimeFetchBridge,
  isLatin1Safe,
  runtimeFetch,
  sanitizeHeadersForBrowser,
  type RuntimeFetchOptions,
} from '@piarium/application-client';
