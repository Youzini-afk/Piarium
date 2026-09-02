// Host relay identity: the EXISTING ECDSA P-256 signing keypair (shared with
// the push relay via signing-key.js — same storage, same serverId) plus a NEW
// long-lived ECDH P-256 encryption keypair for the E2EE channel (WebCrypto
// keys are single-purpose, so signing and encryption keys must differ).
// The encryption keypair is persisted as `settings.relayEncryptionKey =
// { privateJwk, publicJwk }`, mirroring the relaySigningKey precedent.

import {
  canonicalPublicJwkString,
  deriveServerId,
  getOrCreateRelaySigningKeypair,
  signRelayMessage,
} from './signing-key.js';
import { exportPublicKeyJwk, generateEcdhKeyPair, importEcdhPrivateKey } from './e2ee.js';
import type cryptoModule from 'node:crypto';
import type { webcrypto } from 'node:crypto';

interface StoredJwkPair {
  privateJwk: webcrypto.JsonWebKey;
  publicJwk: webcrypto.JsonWebKey;
}

interface RelayIdentitySettings extends Record<string, unknown> {
  relayEncryptionKey?: unknown;
  relaySigningKey?: unknown;
}

export interface RelayIdentity {
  hostEncPrivateKey: webcrypto.CryptoKey;
  hostEncPubJwk: webcrypto.JsonWebKey;
  serverId: string;
  signRelayAuth: (role: string, connectionId?: string | null) => { pk: string; sig: string; ts: number };
}

const isJwkPair = (value: unknown): value is StoredJwkPair => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Boolean(record.privateJwk && typeof record.privateJwk === 'object'
    && record.publicJwk && typeof record.publicJwk === 'object');
};

/**
 * @param {{
 *   crypto: typeof import('node:crypto'),
 *   readSettingsFromDisk: () => Promise<object>,
 *   updateSettingsOnDisk: (mutator: (settings: object) => object) => Promise<object>,
 * }} deps
 */
export const createRelayIdentityRuntime = (deps: {
  crypto: typeof cryptoModule;
  readSettingsFromDisk: () => Promise<RelayIdentitySettings>;
  updateSettingsOnDisk: (
    mutator: (settings: RelayIdentitySettings) => RelayIdentitySettings,
  ) => Promise<RelayIdentitySettings>;
}) => {
  const { crypto, readSettingsFromDisk, updateSettingsOnDisk } = deps;

  let cachedIdentity: RelayIdentity | null = null;

  const getOrCreateEncryptionKeypair = async (): Promise<StoredJwkPair> => {
    const settings = await readSettingsFromDisk();
    const existing = settings?.relayEncryptionKey;
    if (isJwkPair(existing)) {
      return existing;
    }
    // Loud on purpose: a new encryption key invalidates the E2EE trust anchor of
    // every paired device. Expected exactly once, on first relay use.
    console.warn('[relay-identity] Generating NEW relay encryption keypair (E2EE trust anchor changes; previously paired devices must re-pair)');
    const keyPair = await generateEcdhKeyPair();
    const privateJwk = await globalThis.crypto.subtle.exportKey('jwk', keyPair.privateKey);
    const publicJwk = await exportPublicKeyJwk(keyPair.publicKey);
    const updated = await updateSettingsOnDisk((current) => (
      isJwkPair(current?.relayEncryptionKey)
        ? current
        : { ...current, relayEncryptionKey: { privateJwk, publicJwk } }
    ));
    if (!isJwkPair(updated.relayEncryptionKey)) throw new Error('Relay encryption key persistence returned invalid data');
    return updated.relayEncryptionKey;
  };

  /**
   * @returns {Promise<{
   *   serverId: string,
   *   hostEncPubJwk: JsonWebKey,
   *   hostEncPrivateKey: CryptoKey,
   *   signRelayAuth: (role: string, connectionId?: string | null) => { ts: number, sig: string, pk: string },
   * }>}
   */
  const getRelayIdentity = async (): Promise<RelayIdentity> => {
    if (cachedIdentity) return cachedIdentity;
    const signing = await getOrCreateRelaySigningKeypair({ crypto, readSettingsFromDisk, updateSettingsOnDisk });
    const serverId = deriveServerId({ crypto }, signing.publicJwk);
    const encryption = await getOrCreateEncryptionKeypair();
    const hostEncPrivateKey = await importEcdhPrivateKey(encryption.privateJwk);
    const pk = Buffer.from(canonicalPublicJwkString(signing.publicJwk), 'utf8').toString('base64url');

    // Relay-layer auth for host-control / host-data upgrades. Signature payload
    // string is `${ts}.${serverId}.${role}.${connectionId ?? ""}` (spec Layer 1).
    const signRelayAuth = (role: string, connectionId?: string | null) => {
      const ts = Date.now();
      const sig = signRelayMessage({ crypto }, signing.privateKey, `${ts}.${serverId}.${role}.${connectionId ?? ''}`);
      return { ts, sig, pk };
    };

    cachedIdentity = {
      serverId,
      hostEncPubJwk: encryption.publicJwk,
      hostEncPrivateKey,
      signRelayAuth,
    };
    return cachedIdentity;
  };

  return { getRelayIdentity };
};
