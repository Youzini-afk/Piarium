// Private relay service: config persistence, lifecycle of the relay host
// client, and the /api/piarium/relay/* management routes.
//
// Config lives in the server settings file as `settings.privateRelay =
// { enabled, relayUrl }` (same storage precedent as tunnels/notifications).
// Routes are registered with the other Piarium feature routes and are covered
// by the same global UI auth gate.
//
// Cross-runtime parity note: relay host mode intentionally targets the web
// server runtime only in v1 (Electron shares this server in-process). The VS
// Code runtime does not host a relay; shared UI must treat these routes as
// web-runtime capabilities.

import express from 'express';
import type cryptoModule from 'node:crypto';
import type { Express } from 'express';

import { createRelayIdentityRuntime } from './identity.js';
import { startRelayHost } from './host-client.js';
import type { createRelayHostLock } from './host-lock.js';

export const DEFAULT_RELAY_URL = 'wss://relay.openchamber.dev/ws';

interface RelaySettings extends Record<string, unknown> {
  privateRelay?: unknown;
  relayEncryptionKey?: unknown;
  relaySigningKey?: unknown;
}

interface RelayConfig {
  enabled: boolean;
  relayUrl: string;
  relayUrlLocked: boolean;
}

type RelayHostClient = ReturnType<typeof startRelayHost>;
type RelayHostLock = ReturnType<typeof createRelayHostLock>;
type RelayServiceState = 'connected' | 'connecting' | 'disabled' | 'reconnecting' | 'standby';

interface RelayServiceStatus {
  connectedClients: number;
  lastError: string | null;
  state: RelayServiceState;
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const errorMessage = (error: unknown, fallback: string): string => (
  error instanceof Error && error.message ? error.message : fallback
);

const isValidRelayUrl = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'ws:' || url.protocol === 'wss:';
  } catch {
    return false;
  }
};

const normalizeRelayUrl = (value: unknown): string => {
  if (typeof value !== 'string') return DEFAULT_RELAY_URL;
  const trimmed = value.trim();
  if (!trimmed || !isValidRelayUrl(trimmed)) return DEFAULT_RELAY_URL;
  return trimmed;
};

// A deployment can pin the relay endpoint via env (e.g. a self-hosted relay on
// your own Cloudflare account/domain). When set and valid it overrides the
// stored setting entirely, so the host connection, the pairing offer, and the
// status all point at it — clients then inherit it from the offer automatically.
const envRelayUrlOverride = (): string | null => {
  const raw = process.env.PIARIUM_RELAY_URL;
  if (typeof raw !== 'string' || !raw.trim() || !isValidRelayUrl(raw)) return null;
  return raw.trim();
};

/**
 * @param {{
 *   crypto: typeof import('node:crypto'),
 *   readSettingsFromDisk: () => Promise<object>,
 *   updateSettingsOnDisk: (mutator: (settings: object) => object) => Promise<object>,
 *   getLocalPort: () => number,
 *   logger?: Pick<Console, 'warn'>,
 * }} deps
 */
export const createRelayService = ({
  crypto,
  readSettingsFromDisk,
  updateSettingsOnDisk,
  getLocalPort,
  // Returns true when any paired device or pending pairing session uses the
  // relay transport. The relay lifecycle is driven purely by this demand.
  hasRelayDemand = async () => false,
  // Per-machine claim (host-lock.js): all local instances share the same
  // serverId, so only ONE process may run the relay host at a time or they
  // evict each other at the relay worker ("Control replaced") and devices land
  // on a random instance. Optional: without it, behavior is pre-lock.
  hostLock = null,
  logger = console,
}: {
  crypto: typeof cryptoModule;
  getLocalPort: () => number;
  hasRelayDemand?: () => Promise<boolean>;
  hostLock?: RelayHostLock | null;
  logger?: Pick<Console, 'info' | 'warn'>;
  readSettingsFromDisk: () => Promise<RelaySettings>;
  updateSettingsOnDisk: (
    mutator: (settings: RelaySettings) => RelaySettings,
  ) => Promise<RelaySettings>;
}) => {
  const identityRuntime = createRelayIdentityRuntime({ crypto, readSettingsFromDisk, updateSettingsOnDisk });

  let hostClient: RelayHostClient | null = null;
  let status: RelayServiceStatus = { state: 'disabled', lastError: null, connectedClients: 0 };
  // Re-checks the claim while enabled: a standby instance takes over when the
  // claimant dies; a running host stands down when another process claims.
  let claimWatchTimer: ReturnType<typeof setInterval> | null = null;
  const CLAIM_WATCH_INTERVAL_MS = 30_000;

  const readConfig = async (): Promise<RelayConfig> => {
    const settings = await readSettingsFromDisk();
    const stored = asRecord(settings.privateRelay);
    const override = envRelayUrlOverride();
    return {
      enabled: stored?.enabled === true,
      relayUrl: override ?? normalizeRelayUrl(stored?.relayUrl),
      // True when the endpoint is pinned by PIARIUM_RELAY_URL (a self-hosted
      // relay); the stored setting is ignored while it is set.
      relayUrlLocked: override !== null,
    };
  };

  const writeConfig = async (config: Pick<RelayConfig, 'enabled' | 'relayUrl'>): Promise<void> => {
    await updateSettingsOnDisk((settings) => ({
      ...settings,
      privateRelay: { enabled: config.enabled === true, relayUrl: normalizeRelayUrl(config.relayUrl) },
    }));
  };

  const stopHostClient = (): void => {
    if (!hostClient) return;
    hostClient.stop();
    hostClient = null;
  };

  const standbyStatus = (holderPid: number | null): RelayServiceStatus => ({
    state: 'standby',
    lastError: `relay host is owned by another local Piarium process (pid ${holderPid})`,
    connectedClients: 0,
  });

  // Claim watcher, active while the relay is enabled:
  //   - standby → claimant died → take over (start our host);
  //   - running → another live process claimed → stand down (stop, standby).
  // This back-off is what actually ends the mutual-eviction fight: the loser
  // must STOP reconnecting, otherwise both keep replacing each other forever.
  const ensureClaimWatch = (relayUrl: string): void => {
    if (!hostLock || claimWatchTimer) return;
    claimWatchTimer = setInterval(() => {
      void (async () => {
        try {
          if (hostClient) {
            if (!hostLock.holdsClaim() && hostLock.liveClaimantPid() !== null) {
              logger.warn('[Relay] host claim taken by another local instance — standing down');
              const holder = hostLock.liveClaimantPid();
              stopHostClient();
              status = standbyStatus(holder);
            }
            return;
          }
          if (status.state === 'standby' && hostLock.tryClaim()) {
            logger.warn('[Relay] host claim is free — taking over the relay host');
            await start(relayUrl);
          }
        } catch (error) {
          logger.warn(`[Relay] claim watch failed: ${errorMessage(error, 'unknown error')}`);
        }
      })();
    }, CLAIM_WATCH_INTERVAL_MS);
    if (typeof claimWatchTimer.unref === 'function') claimWatchTimer.unref();
  };

  const stopClaimWatch = (): void => {
    if (!claimWatchTimer) return;
    clearInterval(claimWatchTimer);
    claimWatchTimer = null;
  };

  async function start(relayUrl: string, { claim = 'try' }: { claim?: 'force' | 'try' } = {}): Promise<void> {
    if (hostClient) return;
    if (hostLock) {
      const claimed = claim === 'force' ? hostLock.forceClaim() : hostLock.tryClaim();
      if (!claimed) {
        status = standbyStatus(hostLock.liveClaimantPid());
        ensureClaimWatch(relayUrl);
        return;
      }
    }
    const identity = await identityRuntime.getRelayIdentity();
    hostClient = startRelayHost({
      relayUrl,
      identity,
      getLocalPort,
      logger,
      onStatus: (next) => {
        status = next;
      },
    });
    status = hostClient.getStatus();
    ensureClaimWatch(relayUrl);
  }

  const stop = (): void => {
    stopClaimWatch();
    stopHostClient();
    if (hostLock) hostLock.release();
    status = { state: 'disabled', lastError: null, connectedClients: 0 };
  };

  const startIfEnabled = async (): Promise<void> => {
    try {
      const config = await readConfig();
      if (config.enabled) {
        await start(config.relayUrl);
      }
    } catch (error) {
      logger.warn(`[Relay] startup failed: ${errorMessage(error, 'unknown error')}`);
    }
  };

  // Drive the relay lifecycle from demand: run it when a device or pending
  // session uses the relay, stop it when none remain. Called on startup and after
  // pairing/device changes, so the operator never toggles it manually.
  const reconcile = async (): Promise<void> => {
    try {
      const demand = await hasRelayDemand();
      const config = await readConfig();
      if (demand) {
        if (!config.enabled) await writeConfig({ enabled: true, relayUrl: config.relayUrl });
        if (!hostClient) {
          const next = await readConfig();
          await start(next.relayUrl);
        }
      } else {
        if (config.enabled) await writeConfig({ enabled: false, relayUrl: config.relayUrl });
        stop();
      }
    } catch (error) {
      logger.warn(`[Relay] reconcile failed: ${errorMessage(error, 'unknown error')}`);
    }
  };

  // Stable server identity (base64url SHA-256 of the canonical public signing
  // JWK). Derived from a public key, so it is not a secret; clients use it to
  // verify that a learned/probed address belongs to this server before trusting
  // it. Independent of whether the relay host is currently enabled.
  const getServerId = async (): Promise<string> => {
    const identity = await identityRuntime.getRelayIdentity();
    return identity.serverId;
  };

  const getStatus = async () => {
    const config = await readConfig();
    const identity = await identityRuntime.getRelayIdentity();
    const live = hostClient ? hostClient.getStatus() : status;
    return {
      enabled: config.enabled,
      // Without a host client the service is either off or standing by while
      // another local process owns the machine's relay host claim.
      state: hostClient ? live.state : (status.state === 'standby' ? 'standby' : 'disabled'),
      serverId: identity.serverId,
      connectedClients: live.connectedClients,
      relayUrl: config.relayUrl,
      relayUrlLocked: config.relayUrlLocked,
      ...(live.lastError ? { lastError: live.lastError } : {}),
    };
  };

  // Pairing candidate for the unified connection payload (pairing v2). Relay is
  // just another transport: it carries the relay route + E2EE trust anchor, no
  // embedded token — the client redeems the one-time pairing secret over the
  // tunnel like any other candidate. Returns null when the host relay is off, so
  // callers only advertise relay when it is actually reachable. Priority is high
  // (tried after LAN/tunnel) since the relay path is the last-resort transport.
  const buildPairingCandidate = async () => {
    const config = await readConfig();
    const identity = await identityRuntime.getRelayIdentity();
    return {
      type: 'relay',
      relayUrl: config.relayUrl,
      serverId: identity.serverId,
      hostEncPubJwk: identity.hostEncPubJwk,
      priority: 30,
    };
  };

  const getPairingCandidate = async () => {
    const config = await readConfig();
    if (!config.enabled) return null;
    return buildPairingCandidate();
  };

  // Enable the relay host on demand and return its pairing candidate. Creating a
  // relay pairing link IS the demand signal, so the relay turns itself on here
  // rather than requiring a separate manual toggle. Idempotent: a no-op when the
  // relay is already enabled and running.
  const ensureEnabledForPairing = async () => {
    const config = await readConfig();
    if (!config.enabled) {
      await writeConfig({ enabled: true, relayUrl: config.relayUrl });
    }
    if (!hostClient) {
      const next = await readConfig();
      // Force-claim: creating a pairing link is explicit user intent — the
      // instance the user is pairing against MUST be the one devices reach,
      // even if another local process currently holds the machine's claim
      // (its claim watcher sees the takeover and stands down).
      await start(next.relayUrl, { claim: 'force' });
    }
    return buildPairingCandidate();
  };

  const registerRoutes = (app: Express): void => {
    app.get('/api/piarium/relay/status', async (_req, res) => {
      try {
        res.json(await getStatus());
      } catch (error) {
        res.status(500).json({ error: errorMessage(error, 'Failed to read relay status') });
      }
    });

    app.post('/api/piarium/relay/enable', express.json({ limit: '16kb' }), async (req, res) => {
      try {
        const current = await readConfig();
        const relayUrl = typeof req.body?.relayUrl === 'string' ? normalizeRelayUrl(req.body.relayUrl) : current.relayUrl;
        await writeConfig({ enabled: true, relayUrl });
        if (hostClient) stop();
        // Explicit user action: take the machine's host claim like pairing does.
        await start(relayUrl, { claim: 'force' });
        res.json(await getStatus());
      } catch (error) {
        res.status(500).json({ error: errorMessage(error, 'Failed to enable relay') });
      }
    });

    app.post('/api/piarium/relay/disable', async (_req, res) => {
      try {
        const current = await readConfig();
        await writeConfig({ enabled: false, relayUrl: current.relayUrl });
        stop();
        res.json(await getStatus());
      } catch (error) {
        res.status(500).json({ error: errorMessage(error, 'Failed to disable relay') });
      }
    });

  };

  return {
    registerRoutes,
    startIfEnabled,
    reconcile,
    stop,
    getStatus,
    getServerId,
    getPairingCandidate,
    ensureEnabledForPairing,
  };
};
