// Re-export from @piarium/application-client for backward compatibility.
// The canonical implementation lives in application-client/src/transport/.
export {
  configureRuntimeUrlResolver,
  createRuntimeUrlResolver,
  getRuntimeUrlResolver,
  setRuntimeUrlResolver,
  type RuntimeUrlConfig,
  type RuntimeUrlQuery,
  type RuntimeUrlResolver,
} from '@piarium/application-client';
