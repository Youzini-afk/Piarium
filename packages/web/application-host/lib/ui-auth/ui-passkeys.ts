// @ts-nocheck
import crypto from 'crypto';
import path from 'path';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { createSettingsFileStore } from '@piarium/settings-store';
import { resolvePiariumDataDir } from '../platform/data-paths.js';

const DEFAULT_STORE_VERSION = 1;
const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RP_NAME = 'Piarium';

const PIARIUM_DATA_DIR = resolvePiariumDataDir(process);
const PASSKEY_STORE_FILE = path.join(PIARIUM_DATA_DIR, 'ui-passkeys.json');

const createUserId = () => crypto.randomBytes(32).toString('base64url');

const decodeUserId = (value) => {
  if (typeof value !== 'string' || !value) {
    return null;
  }

  try {
    return Uint8Array.from(Buffer.from(value, 'base64url'));
  } catch {
    return null;
  }
};

const normalizeLabel = (value, fallback) => {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized ? normalized.slice(0, 120) : fallback;
};

const normalizeHost = (value) => {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end >= 0 ? trimmed.slice(1, end).toLowerCase() : trimmed.toLowerCase();
  }

  const colonIndex = trimmed.indexOf(':');
  return (colonIndex >= 0 ? trimmed.slice(0, colonIndex) : trimmed).toLowerCase();
};

const isLocalRpId = (rpID) => rpID === 'localhost' || rpID === '127.0.0.1' || rpID === '::1';

const getCurrentRequestOrigin = (req) => {
  const forwardedProto = typeof req.headers['x-forwarded-proto'] === 'string'
    ? req.headers['x-forwarded-proto'].split(',')[0].trim().toLowerCase()
    : '';
  const protocol = forwardedProto || (req.socket?.encrypted ? 'https' : 'http');
  const forwardedHost = typeof req.headers['x-forwarded-host'] === 'string'
    ? req.headers['x-forwarded-host'].split(',')[0].trim()
    : '';
  const host = forwardedHost || (typeof req.headers.host === 'string' ? req.headers.host.trim() : '');

  if (!host) {
    return '';
  }

  return `${protocol}://${host}`;
};

const getCurrentRpId = (req) => {
  const forwardedHost = typeof req.headers['x-forwarded-host'] === 'string'
    ? req.headers['x-forwarded-host'].split(',')[0].trim()
    : '';
  const host = forwardedHost || (typeof req.headers.host === 'string' ? req.headers.host.trim() : '');
  return normalizeHost(host || req.hostname || '');
};

const parseStoredPasskey = (record) => {
  if (!record || typeof record !== 'object') {
    return null;
  }

  if (typeof record.id !== 'string' || typeof record.publicKey !== 'string' || typeof record.rpID !== 'string') {
    return null;
  }

  return {
    id: record.id,
    publicKey: record.publicKey,
    counter: typeof record.counter === 'number' && Number.isFinite(record.counter) ? record.counter : 0,
    transports: Array.isArray(record.transports)
      ? record.transports.filter((value) => typeof value === 'string')
      : [],
    deviceType: typeof record.deviceType === 'string' ? record.deviceType : 'singleDevice',
    backedUp: record.backedUp === true,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
    lastUsedAt: typeof record.lastUsedAt === 'number' ? record.lastUsedAt : null,
    label: normalizeLabel(record.label, 'Unnamed device'),
    rpID: record.rpID,
  };
};

export const createUiPasskeys = ({
  passwordBinding,
  readSettingsFromDisk,
  storeFile = PASSKEY_STORE_FILE,
  rpName = DEFAULT_RP_NAME,
  challengeTtlMs = DEFAULT_CHALLENGE_TTL_MS,
  passkeyStore: providedPasskeyStore,
} = {}) => {
  passwordBinding = typeof passwordBinding === 'string' ? passwordBinding : '';
  const registrationChallenges = new Map();
  const authenticationChallenges = new Map();

  const createEmptyStore = () => ({
    version: DEFAULT_STORE_VERSION,
    userID: createUserId(),
    passwordBinding,
    passkeys: [],
  });
  const passkeyStore = providedPasskeyStore ?? createSettingsFileStore({
    filePath: storeFile,
    defaultValue: createEmptyStore(),
  });

  const normalizeStore = (candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || candidate.version !== DEFAULT_STORE_VERSION) {
      throw new Error(`Unsupported passkey store version: ${String(candidate?.version)}`);
    }
    if (!decodeUserId(candidate.userID) || typeof candidate.passwordBinding !== 'string' || !Array.isArray(candidate.passkeys)) {
      throw new Error('Passkey store is malformed');
    }
    const passkeys = candidate.passkeys.map(parseStoredPasskey);
    if (passkeys.some((passkey) => passkey === null)) {
      throw new Error('Passkey store contains an invalid credential');
    }
    return {
      version: DEFAULT_STORE_VERSION,
      userID: candidate.userID,
      passwordBinding: candidate.passwordBinding,
      passkeys,
    };
  };

  const applyPasswordBinding = (store) => {
    if (!passwordBinding) {
      if (store.passkeys.length === 0 && !store.passwordBinding) return { store, changed: false };
      return { store: { ...store, passkeys: [], passwordBinding: '' }, changed: true };
    }
    if (store.passwordBinding === passwordBinding) return { store, changed: false };
    return {
      store: {
        version: DEFAULT_STORE_VERSION,
        userID: store.userID,
        passwordBinding,
        passkeys: [],
      },
      changed: true,
    };
  };

  const loadStore = () => passkeyStore.transact((persisted) => {
    const binding = applyPasswordBinding(normalizeStore(persisted));
    return {
      document: binding.store,
      result: binding.store,
      write: binding.changed,
    };
  });

  const mutateStore = (mutator) => passkeyStore.transact(async (persisted) => {
    const binding = applyPasswordBinding(normalizeStore(persisted));
    const transaction = await mutator(binding.store);
    return {
      document: binding.store,
      result: transaction.result,
      write: binding.changed || transaction.write !== false,
    };
  });

  const cleanupChallengeMap = (map) => {
    const now = Date.now();
    for (const [requestId, record] of map.entries()) {
      if (!record || now >= record.expiresAt) {
        map.delete(requestId);
      }
    }
  };

  const buildOriginCandidates = async (req) => {
    const origins = new Set();
    const currentOrigin = getCurrentRequestOrigin(req);
    if (currentOrigin) {
      origins.add(currentOrigin);
    }

    try {
      const settings = await readSettingsFromDisk?.();
      if (typeof settings?.publicOrigin === 'string' && settings.publicOrigin.trim().length > 0) {
        origins.add(new URL(settings.publicOrigin.trim()).origin);
      }
    } catch {
    }

    return Array.from(origins);
  };

  const assertEnabled = () => {
    if (!passwordBinding) {
      const error = new Error('Passkeys require UI password protection to be enabled');
      error.statusCode = 400;
      throw error;
    }
  };

  const getPasskeysForRpId = (store, rpID) => store.passkeys.filter((passkey) => passkey.rpID === rpID);

  const getStatus = async (req) => {
    const store = await loadStore();
    const rpID = getCurrentRpId(req);
    return {
      enabled: Boolean(passwordBinding),
      hasPasskeys: Boolean(rpID) && getPasskeysForRpId(store, rpID).length > 0,
      passkeyCount: Boolean(rpID) ? getPasskeysForRpId(store, rpID).length : 0,
      rpID,
    };
  };

  const listPasskeys = async (req) => {
    assertEnabled();

    const store = await loadStore();
    const rpID = getCurrentRpId(req);
    if (!rpID) {
      return [];
    }

    return getPasskeysForRpId(store, rpID).map((passkey) => ({
      id: passkey.id,
      label: passkey.label,
      createdAt: passkey.createdAt,
      lastUsedAt: passkey.lastUsedAt,
      deviceType: passkey.deviceType,
      backedUp: passkey.backedUp,
    }));
  };

  const revokePasskey = async (req, passkeyId) => {
    assertEnabled();

    const normalizedPasskeyId = typeof passkeyId === 'string' ? passkeyId.trim() : '';
    if (!normalizedPasskeyId) {
      const error = new Error('Passkey ID is required');
      error.statusCode = 400;
      throw error;
    }

    const rpID = getCurrentRpId(req);
    return mutateStore(async (store) => {
      const existingPasskey = store.passkeys.find((passkey) => passkey.id === normalizedPasskeyId && passkey.rpID === rpID);
      if (!existingPasskey) {
        const error = new Error('Passkey not found for this host');
        error.statusCode = 404;
        throw error;
      }

      store.passkeys = store.passkeys.filter((passkey) => !(passkey.id === normalizedPasskeyId && passkey.rpID === rpID));
      return {
        result: {
          revoked: true,
          passkeyCount: store.passkeys.filter((passkey) => passkey.rpID === rpID).length,
        },
      };
    });
  };

  const clearAllPasskeys = async () => {
    assertEnabled();
    return mutateStore(async (store) => {
      const clearedCount = store.passkeys.length;
      store.userID = crypto.randomBytes(32).toString('base64url');
      store.passkeys = [];
      return { result: { cleared: true, clearedCount } };
    });
  };

  const beginRegistration = async (req, { label } = {}) => {
    assertEnabled();
    cleanupChallengeMap(registrationChallenges);

    const rpID = getCurrentRpId(req);
    if (!rpID) {
      const error = new Error('Unable to resolve a valid passkey host for this request');
      error.statusCode = 400;
      throw error;
    }

    const currentOrigin = getCurrentRequestOrigin(req);
    if (!currentOrigin) {
      const error = new Error('Unable to resolve a valid passkey origin for this request');
      error.statusCode = 400;
      throw error;
    }

    const store = await loadStore();
    const userID = decodeUserId(store.userID);
    if (!userID) {
      const error = new Error('Passkey storage is invalid. Please try again.');
      error.statusCode = 500;
      throw error;
    }

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID,
      userName: 'piarium-ui',
      userDisplayName: 'Piarium UI',
      attestationType: 'none',
      excludeCredentials: getPasskeysForRpId(store, rpID).map((passkey) => ({
        id: passkey.id,
        transports: passkey.transports,
      })),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
    });

    const requestId = crypto.randomBytes(16).toString('base64url');
    registrationChallenges.set(requestId, {
      challenge: options.challenge,
      expectedOrigins: await buildOriginCandidates(req),
      expectedRPIDs: [rpID],
      rpID,
      label: normalizeLabel(label, 'This device'),
      createdAt: Date.now(),
      expiresAt: Date.now() + challengeTtlMs,
    });

    return {
      requestId,
      optionsJSON: options,
    };
  };

  const finishRegistration = async (payload) => {
    assertEnabled();
    cleanupChallengeMap(registrationChallenges);

    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
    const response = payload?.response;

    const matchingRecord = requestId ? registrationChallenges.get(requestId) : null;
    if (!matchingRecord) {
      const error = new Error('Passkey setup has expired. Please try again.');
      error.statusCode = 400;
      throw error;
    }

    registrationChallenges.delete(requestId);

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: matchingRecord.challenge,
      expectedOrigin: matchingRecord.expectedOrigins,
      expectedRPID: matchingRecord.expectedRPIDs,
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      const error = new Error('Passkey registration could not be verified');
      error.statusCode = 400;
      throw error;
    }

    const {
      credential,
      credentialDeviceType,
      credentialBackedUp,
    } = verification.registrationInfo;

    return mutateStore(async (store) => {
      store.passkeys = store.passkeys.filter((passkey) => passkey.id !== credential.id);
      store.passkeys.push({
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: Array.isArray(credential.transports) ? credential.transports.filter((value) => typeof value === 'string') : [],
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        createdAt: Date.now(),
        lastUsedAt: null,
        label: matchingRecord.label,
        rpID: matchingRecord.rpID,
      });

      return {
        result: {
          verified: true,
          passkeyCount: store.passkeys.filter((passkey) => passkey.rpID === matchingRecord.rpID).length,
        },
      };
    });
  };

  const beginAuthentication = async (req) => {
    assertEnabled();
    cleanupChallengeMap(authenticationChallenges);

    const store = await loadStore();
    const rpID = getCurrentRpId(req);
    const passkeys = getPasskeysForRpId(store, rpID);

    if (!rpID || passkeys.length === 0) {
      const error = new Error('No passkeys are registered for this host yet');
      error.statusCode = 404;
      throw error;
    }

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      allowCredentials: passkeys.map((passkey) => ({
        id: passkey.id,
        transports: passkey.transports,
      })),
    });

    const requestId = crypto.randomBytes(16).toString('base64url');
    authenticationChallenges.set(requestId, {
      challenge: options.challenge,
      expectedOrigins: await buildOriginCandidates(req),
      expectedRPIDs: [rpID],
      createdAt: Date.now(),
      expiresAt: Date.now() + challengeTtlMs,
    });

    return {
      requestId,
      optionsJSON: options,
    };
  };

  const finishAuthentication = async (payload) => {
    assertEnabled();
    cleanupChallengeMap(authenticationChallenges);

    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
    const response = payload?.response;
    const matchingRecord = requestId ? authenticationChallenges.get(requestId) : null;
    if (!matchingRecord) {
      const error = new Error('Passkey sign-in has expired. Please try again.');
      error.statusCode = 400;
      throw error;
    }

    authenticationChallenges.delete(requestId);
    return mutateStore(async (store) => {
      const passkey = store.passkeys.find((item) => item.id === response?.id);
      if (!passkey) {
        const error = new Error('That passkey is not registered for this Piarium instance');
        error.statusCode = 404;
        throw error;
      }

      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: matchingRecord.challenge,
        expectedOrigin: matchingRecord.expectedOrigins,
        expectedRPID: matchingRecord.expectedRPIDs,
        credential: {
          id: passkey.id,
          publicKey: Buffer.from(passkey.publicKey, 'base64url'),
          counter: passkey.counter,
          transports: passkey.transports,
        },
        requireUserVerification: true,
      });

      if (!verification.verified || !verification.authenticationInfo) {
        const error = new Error('Passkey sign-in could not be verified');
        error.statusCode = 400;
        throw error;
      }

      passkey.counter = verification.authenticationInfo.newCounter;
      passkey.lastUsedAt = Date.now();
      return { result: { verified: true } };
    });
  };

  const dispose = () => {
    registrationChallenges.clear();
    authenticationChallenges.clear();
  };

  return {
    enabled: Boolean(passwordBinding),
    getStatus,
    listPasskeys,
    revokePasskey,
    clearAllPasskeys,
    beginRegistration,
    finishRegistration,
    beginAuthentication,
    finishAuthentication,
    dispose,
    isLocalRpId,
  };
};
