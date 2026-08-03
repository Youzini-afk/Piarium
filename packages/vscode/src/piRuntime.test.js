import {
  describe, expect, mock, test,
} from 'bun:test';
import { PIARIUM_PROTOCOL_VERSION } from '@piarium/protocol';

mock.module('vscode', () => ({
  Disposable: class Disposable {
    #callback;

    constructor(callback) {
      this.#callback = callback;
    }

    dispose() {
      this.#callback();
    }
  },
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
  },
}));

const { VSCodePiRuntime } = await import('./piRuntime');

const handshake = {
  capabilities: {
    agentProviders: true,
    extensionUi: true,
    fleet: true,
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
    nodePath: 'C:/node.exe',
    nodeVersion: '24.0.0',
    piVersion: '0.83.0',
    source: 'bundled',
  },
};

describe('VSCodePiRuntime lifecycle', () => {
  test('does not start a replacement broker until the previous broker is disposed', async () => {
    const events = [];
    let releaseDispose = () => undefined;
    const disposalGate = new Promise((resolve) => {
      releaseDispose = resolve;
    });
    const firstBroker = {
      dispose: async () => {
        events.push('first:dispose:start');
        await disposalGate;
        events.push('first:dispose:end');
      },
      warmup: async () => {
        events.push('first:start');
        return handshake;
      },
    };
    const secondBroker = {
      dispose: async () => {
        events.push('second:dispose');
      },
      warmup: async () => {
        events.push('second:start');
        return handshake;
      },
    };
    const brokers = [firstBroker, secondBroker];
    const context = {
      extension: { packageJSON: { version: '0.1.0' } },
      extensionPath: 'C:/extension',
    };
    const output = { appendLine: () => undefined };
    const runtime = new VSCodePiRuntime(context, output, {
      createBroker: () => {
        const broker = brokers.shift();
        if (!broker) throw new Error('unexpected broker creation');
        return broker;
      },
      resolveHostEntry: () => 'C:/extension/pi-host.js',
      resolveNodeExecutable: () => 'C:/node.exe',
    });

    expect(await runtime.start()).toBe(firstBroker);
    const restart = runtime.restart();
    while (!events.includes('first:dispose:start')) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const concurrentStart = runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).not.toContain('second:start');

    releaseDispose();
    await restart;
    expect(await concurrentStart).toBe(secondBroker);
    expect(events).toEqual([
      'first:start',
      'first:dispose:start',
      'first:dispose:end',
      'second:start',
    ]);
    await runtime.stop();
    runtime.dispose();
  });
});
