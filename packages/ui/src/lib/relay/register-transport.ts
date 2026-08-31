/**
 * Registers the UI's relay tunnel implementation with the application-client
 * transport layer. This must be called once during UI startup, before any
 * runtime endpoint switch occurs.
 *
 * The transport layer (runtime-fetch, runtime-auth, runtime-switch) uses
 * the registered provider and lifecycle to route requests through the
 * E2EE relay tunnel when relay mode is active, without importing the
 * UI's relay implementation directly.
 */

import {
  registerRelayTunnelLifecycle,
  registerRelayTunnelProvider,
} from '@piarium/application-client';
import {
  activateRelayTunnel,
  deactivateRelayTunnel,
  getActiveRelayTunnel,
} from '@/lib/relay/runtime-tunnel';

let registered = false;

export const registerRelayTransport = (): void => {
  if (registered) return;
  registered = true;
  registerRelayTunnelProvider(() => getActiveRelayTunnel());
  registerRelayTunnelLifecycle({
    activate: (descriptor) => activateRelayTunnel(descriptor),
    deactivate: () => deactivateRelayTunnel(),
  });
};
