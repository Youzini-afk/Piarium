import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';

import { createRelayIdentityRuntime } from './identity.js';
import { canonicalPublicJwkString } from './signing-key.js';

type IdentityDependencies = Parameters<typeof createRelayIdentityRuntime>[0];
type IdentitySettings = Awaited<ReturnType<IdentityDependencies['readSettingsFromDisk']>>;

const requireRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value as Record<string, unknown>;
};

// In-memory settings store standing in for the on-disk settings file.
const makeSettingsStore = (initial: IdentitySettings = {}) => {
  let settings: IdentitySettings = { ...initial };
  return {
    readSettingsFromDisk: async () => ({ ...settings }),
    updateSettingsOnDisk: async (mutator: IdentityDependencies['updateSettingsOnDisk'] extends (mutator: infer Mutator) => unknown ? Mutator : never) => {
      settings = { ...(await mutator({ ...settings })) };
      return { ...settings };
    },
    peek: () => settings,
  };
};

describe('relay identity', () => {
  it('derives a stable serverId from the signing key and persists both keypairs', async () => {
    const store = makeSettingsStore();
    const runtime = createRelayIdentityRuntime({ crypto, ...store });
    const identity = await runtime.getRelayIdentity();

    const stored = store.peek();
    expect(stored.relaySigningKey).toBeDefined();
    expect(stored.relayEncryptionKey).toBeDefined();

    const expectedServerId = crypto
      .createHash('sha256')
      .update(canonicalPublicJwkString(requireRecord(stored.relaySigningKey).publicJwk as crypto.JsonWebKey))
      .digest('base64url');
    expect(identity.serverId).toBe(expectedServerId);
    expect(identity.hostEncPubJwk.crv).toBe('P-256');
  });

  it('reuses an existing signing key (serverId stays stable across installs)', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    void privateKey;
    const publicJwk = publicKey.export({ format: 'jwk' });
    const store = makeSettingsStore({
      relaySigningKey: {
        privateJwk: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }),
        publicJwk,
      },
    });
    // Match private to public so importing works.
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const storedSigningKey = requireRecord(store.peek().relaySigningKey);
    storedSigningKey.privateJwk = pair.privateKey.export({ format: 'jwk' });
    storedSigningKey.publicJwk = pair.publicKey.export({ format: 'jwk' });

    const runtime = createRelayIdentityRuntime({ crypto, ...store });
    const identity = await runtime.getRelayIdentity();
    const expected = crypto
      .createHash('sha256')
      .update(canonicalPublicJwkString(pair.publicKey.export({ format: 'jwk' })))
      .digest('base64url');
    expect(identity.serverId).toBe(expected);
  });

  it('produces a verifiable relay auth signature', async () => {
    const store = makeSettingsStore();
    const runtime = createRelayIdentityRuntime({ crypto, ...store });
    const identity = await runtime.getRelayIdentity();
    const { ts, sig, pk } = identity.signRelayAuth('host-control', null);

    const canonical = Buffer.from(pk, 'base64url').toString('utf8');
    const publicJwk = JSON.parse(canonical);
    const key = crypto.createPublicKey({ key: publicJwk, format: 'jwk' });
    const ok = crypto.verify(
      'SHA256',
      Buffer.from(`${ts}.${identity.serverId}.host-control.`),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(sig, 'base64url'),
    );
    expect(ok).toBe(true);
  });
});
