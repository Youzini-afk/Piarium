import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as vscode from 'vscode';
import {
  createEvent,
  createRuntimeRequest,
  decodeRuntimeEnvelope,
  encodeRuntimeEnvelope,
  PIARIUM_PROTOCOL_VERSION,
} from '@piarium/protocol';
import type {
  PiRuntimeBroker,
  PiRuntimeBrokerEvent,
} from '@piarium/runtime-broker/core';
import type { VSCodePiRuntime } from './piRuntime';
import { PiRuntimeWebviewBridge } from './piRuntimeWebviewBridge';

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for runtime bridge output');
};

test('VS Code webview bridge dispatches Runtime frames and routed events', async () => {
  const listeners = new Set<(event: PiRuntimeBrokerEvent) => void>();
  const broker = {
    listSessions: async () => [],
    subscribe(listener: (event: PiRuntimeBrokerEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    warmup: async () => ({
      capabilities: {
        agentProviders: true,
        extensionUi: true,
        models: true,
        packages: true,
        providerConfiguration: true,
        recovery: true,
        resources: true,
        sessions: true,
        settings: true,
      },
      hostVersion: '0.1.0',
      protocolVersion: PIARIUM_PROTOCOL_VERSION,
      runtime: {
        agentDir: 'C:/agent',
        nodePath: 'node',
        nodeVersion: process.version,
        piVersion: '0.83.0',
        source: 'bundled' as const,
      },
    }),
  } as unknown as PiRuntimeBroker;
  const runtime = { start: async () => broker } as unknown as VSCodePiRuntime;
  const messages: Array<{ frame?: string; type?: string }> = [];
  const webview = {
    postMessage: async (message: { frame?: string; type?: string }) => {
      messages.push(message);
      return true;
    },
  } as unknown as vscode.Webview;
  const bridge = new PiRuntimeWebviewBridge(webview, runtime);
  try {
    assert.equal(bridge.handleMessage({
      frame: encodeRuntimeEnvelope(createRuntimeRequest('handshake', 'host.handshake', {
        clientName: 'vscode-bridge-test',
        clientVersion: '0.1.0',
        mode: 'vscode',
        protocolVersions: [PIARIUM_PROTOCOL_VERSION],
      })),
      type: 'piarium:runtime:frame',
    }), true);
    await waitFor(() => messages.length === 1);
    const handshake = decodeRuntimeEnvelope(messages[0]?.frame ?? '');
    assert.equal(handshake.kind, 'response');
    if (handshake.kind !== 'response') assert.fail('expected handshake response');
    assert.equal(handshake.id, 'handshake');
    assert.equal(handshake.ok, true);
    if (!handshake.ok) assert.fail('expected handshake success');
    assert.equal(
      (handshake.result as { protocolVersion?: unknown }).protocolVersion,
      PIARIUM_PROTOCOL_VERSION,
    );

    for (const listener of listeners) listener({
      envelope: createEvent(4, 'session.closed', { sessionId: 'session-1' }),
      kind: 'host',
      role: 'session',
      sessionId: 'session-1',
      workerId: 'worker-1',
    });
    await waitFor(() => messages.length === 2);
    const event = decodeRuntimeEnvelope(messages[1]?.frame ?? '');
    assert.equal(event.kind, 'event');
    if (event.kind !== 'event') assert.fail('expected routed event');
    assert.equal(event.event, 'session.closed');
    assert.deepEqual(event.source, {
      role: 'session',
      sessionId: 'session-1',
      workerId: 'worker-1',
    });
  } finally {
    bridge.dispose();
  }
  assert.equal(listeners.size, 0);
});

test('VS Code webview close invalidates a frame waiting for runtime startup', async () => {
  let releaseRuntime!: (broker: PiRuntimeBroker) => void;
  const runtimeStarted = new Promise<PiRuntimeBroker>((resolve) => {
    releaseRuntime = resolve;
  });
  let subscriptions = 0;
  const broker = {
    subscribe() {
      subscriptions += 1;
      return () => {
        subscriptions -= 1;
      };
    },
  } as unknown as PiRuntimeBroker;
  const runtime = { start: async () => runtimeStarted } as unknown as VSCodePiRuntime;
  const messages: unknown[] = [];
  const webview = {
    postMessage: async (message: unknown) => {
      messages.push(message);
      return true;
    },
  } as unknown as vscode.Webview;
  const bridge = new PiRuntimeWebviewBridge(webview, runtime);

  assert.equal(bridge.handleMessage({
    frame: encodeRuntimeEnvelope(createRuntimeRequest('handshake', 'host.handshake', {
      clientName: 'vscode-close-race-test',
      clientVersion: '0.1.0',
      mode: 'vscode',
      protocolVersions: [PIARIUM_PROTOCOL_VERSION],
    })),
    type: 'piarium:runtime:frame',
  }), true);
  assert.equal(bridge.handleMessage({ type: 'piarium:runtime:close' }), true);

  releaseRuntime(broker);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(subscriptions, 0);
  assert.deepEqual(messages, []);
  bridge.dispose();
});
