import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { attachContentLengthReader, writeContentLengthMessage } from './content-length.js';
import { createDapClient } from './dap.js';

const waitUntil = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for DAP frame');
};

describe('DAP transport', () => {
  it('uses standard request, response, and event envelopes instead of JSON-RPC', async () => {
    const adapterOutput = new PassThrough();
    const clientOutput = new PassThrough();
    const frames = [];
    const detach = attachContentLengthReader(clientOutput, (message) => frames.push(message));
    const client = createDapClient({ input: adapterOutput, output: clientOutput });
    try {
      const initialized = client.waitForEvent('initialized');
      const initialize = client.request('initialize', { clientID: 'piarium' });
      await waitUntil(() => frames.length === 1);
      expect(frames[0]).toEqual({
        seq: 1,
        type: 'request',
        command: 'initialize',
        arguments: { clientID: 'piarium' },
      });
      expect(frames[0].jsonrpc).toBeUndefined();

      writeContentLengthMessage(adapterOutput, {
        seq: 1,
        type: 'response',
        request_seq: 1,
        success: true,
        command: 'initialize',
        body: { supportsConfigurationDoneRequest: true },
      });
      await expect(initialize).resolves.toEqual({ supportsConfigurationDoneRequest: true });
      writeContentLengthMessage(adapterOutput, {
        seq: 2,
        type: 'event',
        event: 'initialized',
        body: {},
      });
      await expect(initialized).resolves.toEqual({});
    } finally {
      client.dispose();
      detach();
    }
  });
});
