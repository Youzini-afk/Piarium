// Cross-compatibility: the JS host e2ee must interoperate with the normative TS
// modules in packages/ui/src/lib/relay. bun runs TS directly, so import the TS
// client handshake and drive a full TS-client <-> JS-host exchange both ways.

import { describe, expect, it } from 'vitest';

import { createHostHandshake, exportPublicKeyJwk, generateEcdhKeyPair } from './e2ee.js';
import type { HostHandshakeAction, RelayFrameChannel } from './e2ee.js';
import {
  TunnelFrameType as JsFrameType,
  decodeFrameBatch as jsDecodeBatch,
  decodeTunnelFrame as jsDecode,
  encodeFrameBatch as jsEncodeBatch,
  encodeTunnelFrame as jsEncode,
} from './tunnel-codec.js';

type ClientHandshakeAction =
  | { batch: boolean; channel: RelayFrameChannel; type: 'established' }
  | { text: string; type: 'send-text' }
  | { type: 'ignore' };

interface ClientHandshake {
  handleText(text: string): Promise<ClientHandshakeAction>;
  helloText: string;
}

interface UiTunnelCodec {
  decodeFrameBatch(plaintext: Uint8Array): Uint8Array[];
  decodeTunnelFrame(frame: Uint8Array): { frameType: number; streamId: number };
  encodeFrameBatch(frames: Uint8Array[]): Uint8Array;
  encodeTunnelFrame(frameType: number, streamId: number, payload: Uint8Array): Uint8Array;
}

const handshakePath = new URL('../../../../ui/src/lib/relay/handshake.ts', import.meta.url).href;
const codecPath = new URL('../../../../ui/src/lib/relay/tunnel-codec.ts', import.meta.url).href;
const protocolPath = new URL('../../../../ui/src/lib/relay/protocol.ts', import.meta.url).href;
const { createClientHandshake } = await import(handshakePath) as unknown as {
  createClientHandshake(hostPublicJwk: unknown, options?: { batch?: boolean }): Promise<ClientHandshake>;
};
const uiCodec = await import(codecPath) as unknown as UiTunnelCodec;
const { TunnelFrameType: TsFrameType } = await import(protocolPath) as unknown as {
  TunnelFrameType: Record<string, number>;
};
const {
  decodeFrameBatch: tsDecodeBatch,
  decodeTunnelFrame: tsDecode,
  encodeFrameBatch: tsEncodeBatch,
  encodeTunnelFrame: tsEncode,
} = uiCodec;

const requireHostEstablished = (action: HostHandshakeAction) => {
  if (action.type !== 'established') throw new Error(`Expected host established, got ${action.type}`);
  return action;
};

const requireClientEstablished = (action: ClientHandshakeAction) => {
  if (action.type !== 'established') throw new Error(`Expected client established, got ${action.type}`);
  return action;
};

const frameType = (name: string): number => {
  const value = TsFrameType[name];
  if (typeof value !== 'number') throw new Error(`Missing UI tunnel frame type: ${name}`);
  return value;
};

describe('relay JS-host <-> TS-client cross compatibility', () => {
  it('completes a handshake and exchanges frames both ways', async () => {
    const hostKeys = await generateEcdhKeyPair();
    const hostPubJwk = await exportPublicKeyJwk(hostKeys.publicKey);

    const jsHost = createHostHandshake(hostKeys.privateKey);
    const tsClient = await createClientHandshake(hostPubJwk);

    // TS client hello -> JS host establishes and replies ready.
    const hostAction = await jsHost.handleText(tsClient.helloText);
    expect(hostAction.type).toBe('established');
    const establishedHost = requireHostEstablished(hostAction);
    const hostChannel = establishedHost.channel;

    // JS host ready -> TS client establishes.
    const clientAction = await tsClient.handleText(establishedHost.replyText);
    expect(clientAction.type).toBe('established');
    const clientChannel = requireClientEstablished(clientAction).channel;

    // TS client -> JS host.
    const up = new TextEncoder().encode('ts client speaking');
    const upPlain = await hostChannel.decryptor.decrypt(await clientChannel.encryptor.encrypt(up));
    expect(new TextDecoder().decode(upPlain)).toBe('ts client speaking');

    // JS host -> TS client.
    const down = new TextEncoder().encode('js host replying');
    const downPlain = await clientChannel.decryptor.decrypt(await hostChannel.encryptor.encrypt(down));
    expect(new TextDecoder().decode(downPlain)).toBe('js host replying');
  });

  it('tunnel frames are byte-compatible across TS and JS codecs', () => {
    const payload = new TextEncoder().encode('{"method":"GET"}');
    const tsFrame = tsEncode(frameType('HttpRequest'), 5, payload);
    const jsFrame = jsEncode(JsFrameType.HttpRequest, 5, payload);
    expect(Array.from(jsFrame)).toEqual(Array.from(tsFrame));

    const decodedByJs = jsDecode(tsFrame);
    const decodedByTs = tsDecode(jsFrame);
    expect(decodedByJs.streamId).toBe(5);
    expect(decodedByTs.streamId).toBe(5);
    expect(decodedByJs.frameType).toBe(frameType('HttpRequest'));
  });

  it('negotiates batching between a TS client and a JS host, then exchanges a batch', async () => {
    const hostKeys = await generateEcdhKeyPair();
    const hostPubJwk = await exportPublicKeyJwk(hostKeys.publicKey);

    const jsHost = createHostHandshake(hostKeys.privateKey);
    const tsClient = await createClientHandshake(hostPubJwk);

    const hostAction = await jsHost.handleText(tsClient.helloText);
    expect(hostAction.type).toBe('established');
    const establishedHost = requireHostEstablished(hostAction);
    expect(establishedHost.batch).toBe(true);
    const clientAction = await tsClient.handleText(establishedHost.replyText);
    expect(clientAction.type).toBe('established');
    const establishedClient = requireClientEstablished(clientAction);
    expect(establishedClient.batch).toBe(true);

    // TS client encodes a multi-frame batch -> JS host decodes it byte-identically.
    const frames = [
      tsEncode(frameType('HttpBody'), 1, new TextEncoder().encode('alpha')),
      tsEncode(frameType('HttpBody'), 1, new TextEncoder().encode('beta')),
      tsEncode(frameType('HttpBody'), 1, new TextEncoder().encode('gamma')),
    ];
    const overWire = await establishedHost.channel.decryptor.decrypt(
      await establishedClient.channel.encryptor.encrypt(tsEncodeBatch(frames)),
    );
    const jsFrames = jsDecodeBatch(overWire);
    expect(jsFrames.length).toBe(3);
    jsFrames.forEach((frame, index) => {
      const expected = frames[index];
      if (!expected) throw new Error('Expected source frame');
      expect(Array.from(frame)).toEqual(Array.from(expected));
    });

    // JS host encodes a batch -> TS client decodes it.
    const downFrames = [
      jsEncode(JsFrameType.HttpBody, 1, new TextEncoder().encode('down-1')),
      jsEncode(JsFrameType.HttpBody, 1, new TextEncoder().encode('down-2')),
    ];
    const downWire = await establishedClient.channel.decryptor.decrypt(
      await establishedHost.channel.encryptor.encrypt(jsEncodeBatch(downFrames)),
    );
    const tsFrames = tsDecodeBatch(downWire);
    expect(tsFrames.length).toBe(2);
    tsFrames.forEach((frame, index) => {
      const expected = downFrames[index];
      if (!expected) throw new Error('Expected source frame');
      expect(Array.from(frame)).toEqual(Array.from(expected));
    });
  });

  it('falls back to legacy (no batch) when either peer does not advertise batching', async () => {
    const hostKeys = await generateEcdhKeyPair();
    const hostPubJwk = await exportPublicKeyJwk(hostKeys.publicKey);

    // Legacy JS host (batch:false) vs batch-capable TS client -> batching off.
    const legacyHost = createHostHandshake(hostKeys.privateKey, { batch: false });
    const tsClient = await createClientHandshake(hostPubJwk);
    const hostAction = await legacyHost.handleText(tsClient.helloText);
    expect(hostAction.type).toBe('established');
    const establishedHost = requireHostEstablished(hostAction);
    expect(establishedHost.batch).toBe(false);
    const clientAction = await tsClient.handleText(establishedHost.replyText);
    expect(clientAction.type).toBe('established');
    const establishedClient = requireClientEstablished(clientAction);
    expect(establishedClient.batch).toBe(false);

    // Legacy wire: plaintext is a single raw tunnel frame (no container tag).
    const frame = tsEncode(frameType('HttpBody'), 1, new TextEncoder().encode('legacy'));
    const overWire = await establishedHost.channel.decryptor.decrypt(
      await establishedClient.channel.encryptor.encrypt(frame),
    );
    expect(jsDecode(overWire).frameType).toBe(JsFrameType.HttpBody);

    // Batch-capable JS host vs legacy TS client (batch:false) -> also off.
    const host2 = createHostHandshake(hostKeys.privateKey);
    const legacyClient = await createClientHandshake(hostPubJwk, { batch: false });
    const host2Action = await host2.handleText(legacyClient.helloText);
    const establishedHost2 = requireHostEstablished(host2Action);
    expect(establishedHost2.batch).toBe(false);
    const client2Action = await legacyClient.handleText(establishedHost2.replyText);
    expect(requireClientEstablished(client2Action).batch).toBe(false);
  });
});
