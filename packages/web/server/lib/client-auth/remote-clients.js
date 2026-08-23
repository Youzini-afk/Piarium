import { createSettingsFileStore } from '@piarium/settings-store';

const STORE_VERSION = 2;
const TOKEN_PREFIX = 'piarium_client_';
const TOKEN_BYTES = 32;
const MAX_LABEL_LENGTH = 80;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const AUDIT_STORE_VERSION = 1;
const DEFAULT_AUDIT_LIMIT = 200;
const MAX_AUDIT_LIMIT = 1000;
const MAX_AUDIT_LINE_BYTES = 16 * 1024;

export const REMOTE_CLIENT_PROFILE = Object.freeze({
  CLIENT: 'client',
  READONLY: 'readonly',
  EXTERNAL_AGENT: 'external-agent',
  FULL_CONTROL: 'full-control',
  RESCUE: 'rescue',
});

export const FULL_CONTROL_CAPABILITIES = Object.freeze([
  'instance:read',
  'instance:write',
  'filesystem:read',
  'filesystem:write',
  'filesystem:delete',
  'workspace:read',
  'workspace:write',
  'git:read',
  'git:write',
  'config:read',
  'config:write',
  'logs:read',
  'terminal:use',
  'process:control',
  'update:install',
]);

const READONLY_CAPABILITIES = Object.freeze([
  'instance:read',
  'filesystem:read',
  'workspace:read',
  'git:read',
  'config:read',
  'logs:read',
]);

const DEFAULT_CLIENT_CAPABILITIES = Object.freeze([
  'ui:access',
]);

const normalizeLabel = (value) => {
  if (typeof value !== 'string') return 'Remote client';
  const trimmed = value.trim();
  if (!trimmed) return 'Remote client';
  return trimmed.length > MAX_LABEL_LENGTH ? trimmed.slice(0, MAX_LABEL_LENGTH) : trimmed;
};

const normalizeTimestamp = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const time = Date.parse(trimmed);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const normalizeOptionalString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeProfile = (value) => {
  const raw = normalizeOptionalString(value);
  if (!raw) return REMOTE_CLIENT_PROFILE.CLIENT;
  const normalized = raw.toLowerCase().replace(/_/g, '-');
  if (normalized === 'agent' || normalized === 'external') return REMOTE_CLIENT_PROFILE.EXTERNAL_AGENT;
  if (normalized === 'full' || normalized === 'admin' || normalized === 'full-access') return REMOTE_CLIENT_PROFILE.FULL_CONTROL;
  if (normalized === 'read-only') return REMOTE_CLIENT_PROFILE.READONLY;
  if (Object.values(REMOTE_CLIENT_PROFILE).includes(normalized)) return normalized;
  return normalized.replace(/[^a-z0-9:-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || REMOTE_CLIENT_PROFILE.CLIENT;
};

export const getCapabilitiesForProfile = (profile) => {
  const normalized = normalizeProfile(profile);
  if (
    normalized === REMOTE_CLIENT_PROFILE.FULL_CONTROL ||
    normalized === REMOTE_CLIENT_PROFILE.EXTERNAL_AGENT ||
    normalized === REMOTE_CLIENT_PROFILE.RESCUE
  ) {
    return [...FULL_CONTROL_CAPABILITIES];
  }
  if (normalized === REMOTE_CLIENT_PROFILE.READONLY) {
    return [...READONLY_CAPABILITIES];
  }
  return [...DEFAULT_CLIENT_CAPABILITIES];
};

const normalizeCapabilities = (value, profile) => {
  const fallback = getCapabilitiesForProfile(profile);
  if (!Array.isArray(value)) return fallback;
  const normalized = Array.from(new Set(
    value
      .filter((entry) => typeof entry === 'string')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  ));
  return normalized.length > 0 ? normalized : fallback;
};

const normalizeStringArray = (value) => {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .filter((entry) => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean)
  ));
};

const normalizeMetadata = (client) => ({
  authMethod: normalizeOptionalString(client.authMethod),
  pairingId: normalizeOptionalString(client.pairingId),
  deviceName: normalizeOptionalString(client.deviceName),
  devicePlatform: normalizeOptionalString(client.devicePlatform),
  deviceModel: normalizeOptionalString(client.deviceModel),
  appVersion: normalizeOptionalString(client.appVersion),
});

const safeJsonParse = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const constantTimeEqual = (left, right, crypto) => {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

export const createRemoteClientAuthRuntime = ({ fsPromises, path, crypto, storePath, clientStore: providedClientStore }) => {
  const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
  const nowIso = () => new Date().toISOString();
  const generateId = () => crypto.randomBytes(12).toString('hex');
  const generateToken = () => `${TOKEN_PREFIX}${crypto.randomBytes(TOKEN_BYTES).toString('base64url')}`;
  const auditPath = path.join(path.dirname(storePath), 'external-access-audit.jsonl');
  const emptyStore = () => ({ version: STORE_VERSION, clients: [] });
  const clientStore = providedClientStore ?? createSettingsFileStore({
    filePath: storePath,
    defaultValue: emptyStore(),
  });

  const normalizeStore = (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.version !== STORE_VERSION) {
      throw new Error(`Unsupported remote clients version: ${String(payload?.version)}`);
    }
    if (!Array.isArray(payload.clients)) {
      throw new Error('Remote clients file has invalid clients');
    }
    const clients = payload.clients.map((client) => {
          if (!client || typeof client !== 'object' || Array.isArray(client)) {
            throw new Error('Remote clients file contains an invalid client');
          }
          const id = normalizeOptionalString(client.id);
          const tokenHash = normalizeOptionalString(client.tokenHash);
          if (!id || !tokenHash) {
            throw new Error('Remote clients file contains an incomplete client');
          }
          const profile = normalizeProfile(client.profile);
          return {
            id,
            label: normalizeLabel(client.label),
            tokenHash,
            createdAt: typeof client.createdAt === 'string' ? client.createdAt : nowIso(),
            lastUsedAt: typeof client.lastUsedAt === 'string' ? client.lastUsedAt : null,
            revokedAt: typeof client.revokedAt === 'string' ? client.revokedAt : null,
            expiresAt: normalizeTimestamp(client.expiresAt),
            clientKind: normalizeOptionalString(client.clientKind),
            dedupeKey: normalizeOptionalString(client.dedupeKey),
            profile,
            capabilities: normalizeCapabilities(client.capabilities, profile),
            allowedDirectories: normalizeStringArray(client.allowedDirectories),
            usesRelay: client.usesRelay === true,
            lastTransport: client.lastTransport === 'relay' || client.lastTransport === 'direct' ? client.lastTransport : null,
            ...normalizeMetadata(client),
          };
        });
    return { version: STORE_VERSION, clients };
  };

  const readStore = async () => normalizeStore(await clientStore.read());

  const mutateStore = (mutator) => clientStore.transact(async (persisted) => {
    const store = normalizeStore(persisted);
    const transaction = await mutator(store);
    return {
      document: store,
      result: transaction.result,
      write: transaction.write !== false,
    };
  });

  const publicClient = (client) => ({
    id: client.id,
    label: client.label,
    createdAt: client.createdAt,
    lastUsedAt: client.lastUsedAt,
    revokedAt: client.revokedAt,
    expiresAt: client.expiresAt,
    clientKind: client.clientKind,
    profile: client.profile,
    capabilities: client.capabilities,
    allowedDirectories: client.allowedDirectories,
    authMethod: client.authMethod,
    pairingId: client.pairingId,
    deviceName: client.deviceName,
    devicePlatform: client.devicePlatform,
    deviceModel: client.deviceModel,
    appVersion: client.appVersion,
    usesRelay: client.usesRelay === true,
    lastTransport: client.lastTransport ?? null,
  });

  const listClients = async () => {
    const store = await readStore();
    return store.clients.map(publicClient);
  };

  // Relay demand includes both pairing-time intent and the authoritative fact
  // that a device has actually reached this host through the relay.
  const hasActiveRelayClients = async () => {
    const store = await readStore();
    const now = Date.now();
    return store.clients.some((client) => {
      if (client.usesRelay !== true && client.lastTransport !== 'relay') return false;
      if (client.revokedAt) return false;
      const expires = Date.parse(client.expiresAt || '');
      return !Number.isFinite(expires) || expires > now;
    });
  };

  const createClient = async ({
    label,
    expiresAt,
    clientKind,
    dedupeKey,
    authMethod,
    pairingId,
    deviceName,
    devicePlatform,
    deviceModel,
    appVersion,
    usesRelay,
    profile,
    capabilities,
    allowedDirectories,
  } = {}) => {
    return mutateStore(async (store) => {
      const normalizedDedupeKey = normalizeOptionalString(dedupeKey);
      const normalizedProfile = normalizeProfile(profile);
      const token = generateToken();
      const client = {
        id: generateId(),
        label: normalizeLabel(label),
        tokenHash: hashToken(token),
        createdAt: nowIso(),
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: normalizeTimestamp(expiresAt),
        clientKind: normalizeOptionalString(clientKind),
        dedupeKey: normalizedDedupeKey,
        profile: normalizedProfile,
        capabilities: normalizeCapabilities(capabilities, normalizedProfile),
        allowedDirectories: normalizeStringArray(allowedDirectories),
        authMethod: normalizeOptionalString(authMethod),
        pairingId: normalizeOptionalString(pairingId),
        deviceName: normalizeOptionalString(deviceName),
        devicePlatform: normalizeOptionalString(devicePlatform),
        deviceModel: normalizeOptionalString(deviceModel),
        appVersion: normalizeOptionalString(appVersion),
        usesRelay: usesRelay === true,
      };
      if (normalizedDedupeKey) {
        store.clients = store.clients.filter((entry) => entry.dedupeKey !== normalizedDedupeKey);
        // Migrate pre-clientKind desktop tokens: a deduped, kind-tagged mint
        // supersedes legacy records with the same label that carry neither a
        // kind nor a dedupe key — those tokens can no longer pass the
        // desktop-local client-create gate and would otherwise linger forever.
        if (client.clientKind) {
          store.clients = store.clients.filter((entry) =>
            !(entry.label === client.label && !entry.clientKind && !entry.dedupeKey));
        }
      }
      store.clients.push(client);
      return { result: { client: publicClient(client), token } };
    });
  };

  const revokeClient = async (id) => {
    if (typeof id !== 'string' || id.trim().length === 0) {
      return { revoked: false };
    }
    return mutateStore(async (store) => {
      const client = store.clients.find((entry) => entry.id === id);
      if (!client) return { result: { revoked: false }, write: false };
      if (client.revokedAt) return { result: { revoked: true, client: publicClient(client) }, write: false };
      client.revokedAt = nowIso();
      return { result: { revoked: true, client: publicClient(client) } };
    });
  };

  const purgeRevokedClients = async () => {
    return mutateStore(async (store) => {
      const before = store.clients.length;
      store.clients = store.clients.filter((entry) => !entry.revokedAt);
      const purged = before - store.clients.length;
      return { result: { purged }, write: purged > 0 };
    });
  };

  const authenticateBearerToken = async (token, req) => {
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) {
      return null;
    }
    // Which transport carried this request: the relay tunnel proxy stamps every
    // forwarded request with x-piarium-relay-connection; anything else is a
    // direct (local/LAN/tunnel-URL) request. This also drives relay demand.
    const transport = req?.headers?.['x-piarium-relay-connection'] ? 'relay' : 'direct';
    return mutateStore(async (store) => {
      const tokenHash = hashToken(token);
      const client = store.clients.find((entry) => !entry.revokedAt && constantTimeEqual(entry.tokenHash, tokenHash, crypto));
      if (!client) return { result: null, write: false };
      if (client.expiresAt && Date.parse(client.expiresAt) <= Date.now()) return { result: null, write: false };
      const now = Date.now();
      const lastUsedAt = Date.parse(client.lastUsedAt || '');
      // A relayed request proves this client depends on the relay even if it was
      // created before usesRelay existed. Keep the signal sticky: a later LAN
      // request does not make the remote path unnecessary.
      const healUsesRelay = transport === 'relay' && client.usesRelay !== true;
      if (healUsesRelay) client.usesRelay = true;
      // Write on the throttle interval — or immediately when the transport
      // changed, so a LAN⇄relay switch is visible right away, not a minute late.
      const shouldWrite = healUsesRelay
        || !Number.isFinite(lastUsedAt)
        || now - lastUsedAt >= LAST_USED_WRITE_INTERVAL_MS
        || client.lastTransport !== transport;
      if (shouldWrite) {
        client.lastUsedAt = new Date(now).toISOString();
        client.lastTransport = transport;
      }
      return {
        result: { ok: true, clientId: client.id, sessionToken: client.id, client: publicClient(client) },
        write: shouldWrite,
      };
    });
  };

  const recordAuditEvent = async (event = {}) => {
    const clientId = normalizeOptionalString(event.clientId);
    if (!clientId) return { recorded: false };
    const entry = {
      version: AUDIT_STORE_VERSION,
      time: nowIso(),
      clientId,
      label: normalizeOptionalString(event.label),
      profile: normalizeOptionalString(event.profile),
      method: normalizeOptionalString(event.method),
      path: normalizeOptionalString(event.path),
      status: Number.isInteger(event.status) ? event.status : null,
      ip: normalizeOptionalString(event.ip),
      userAgent: normalizeOptionalString(event.userAgent),
      durationMs: Number.isFinite(event.durationMs) ? Math.max(0, Math.round(event.durationMs)) : null,
      target: event.target && typeof event.target === 'object' ? event.target : null,
    };
    let line = `${JSON.stringify(entry)}\n`;
    if (Buffer.byteLength(line, 'utf8') > MAX_AUDIT_LINE_BYTES) {
      entry.target = { truncated: true };
      line = `${JSON.stringify(entry)}\n`;
    }
    await fsPromises.mkdir(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    await fsPromises.appendFile(auditPath, line, { encoding: 'utf8', mode: 0o600 });
    if (typeof fsPromises.chmod === 'function') {
      await fsPromises.chmod(auditPath, 0o600).catch(() => {});
    }
    return { recorded: true };
  };

  const listAuditEvents = async ({ limit = DEFAULT_AUDIT_LIMIT } = {}) => {
    const normalizedLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || DEFAULT_AUDIT_LIMIT, 1), MAX_AUDIT_LIMIT);
    let raw = '';
    try {
      raw = await fsPromises.readFile(auditPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-normalizedLimit)
      .map((line) => safeJsonParse(line))
      .filter((entry) => entry && typeof entry === 'object')
      .reverse();
  };

  return {
    authenticateBearerToken,
    createClient,
    getCapabilitiesForProfile,
    listAuditEvents,
    listClients,
    hasActiveRelayClients,
    purgeRevokedClients,
    recordAuditEvent,
    revokeClient,
  };
};
