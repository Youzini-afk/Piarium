// Re-export from @piarium/application-client for backward compatibility.
// The canonical implementation lives in application-client/src/transport/.
export {
  getActiveRelayTunnel,
  getRuntimeApiBaseUrl,
  getRuntimeEndpointGeneration,
  getRuntimeKey,
  initializeRuntimeEndpoint,
  registerRuntimeEndpointSwitchBlocker,
  subscribeRuntimeEndpointChanged,
  subscribeRuntimeEndpointWillChange,
  switchRuntimeEndpoint,
  switchRuntimeEndpointSafely,
  type RelayRuntimeDescriptor,
  type RuntimeEndpointChangedDetail,
  type RuntimeEndpointSwitchBlocker,
  type RuntimeEndpointSwitchOptions,
} from '@piarium/application-client';
