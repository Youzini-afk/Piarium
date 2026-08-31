/**
 * Relay tunnel provider interface.
 *
 * The transport layer (runtime-fetch, runtime-auth) needs to route
 * requests through an E2EE relay tunnel when relay mode is active.
 * The relay implementation lives in packages/ui (it depends on
 * browser APIs and crypto). This interface allows the UI to register
 * its relay tunnel provider at startup, keeping the transport layer
 * framework-neutral.
 */

export interface RelayTunnelFetchClient {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface RelayRuntimeDescriptor {
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: JsonWebKey;
  grant?: string;
}

/**
 * Provider that returns the active relay tunnel client, or null when
 * relay mode is not active.
 */
export type RelayTunnelProvider = () => RelayTunnelFetchClient | null;

/**
 * Lifecycle hooks for activating/deactivating the relay tunnel.
 * The UI registers these at startup so runtime-switch can control
 * the relay without importing the UI's relay implementation.
 */
export interface RelayTunnelLifecycle {
  activate(descriptor: RelayRuntimeDescriptor): void;
  deactivate(): void;
}

let registeredProvider: RelayTunnelProvider = () => null;
let registeredLifecycle: RelayTunnelLifecycle | null = null;

/**
 * Register the relay tunnel provider. Called once during UI startup
 * to connect the transport layer to the UI's relay implementation.
 */
export const registerRelayTunnelProvider = (provider: RelayTunnelProvider): void => {
  registeredProvider = provider;
};

/**
 * Register the relay tunnel lifecycle hooks. Called once during UI
 * startup so runtime-switch can activate/deactivate the tunnel.
 */
export const registerRelayTunnelLifecycle = (lifecycle: RelayTunnelLifecycle): void => {
  registeredLifecycle = lifecycle;
};

/**
 * Get the active relay tunnel client, or null.
 */
export const getActiveRelayTunnel = (): RelayTunnelFetchClient | null => registeredProvider();

/**
 * Activate the relay tunnel with the given descriptor.
 */
export const activateRelayTunnel = (descriptor: RelayRuntimeDescriptor): void => {
  registeredLifecycle?.activate(descriptor);
};

/**
 * Deactivate the relay tunnel.
 */
export const deactivateRelayTunnel = (): void => {
  registeredLifecycle?.deactivate();
};
