import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { attachContentLengthReader, writeContentLengthMessage } from '../run/content-length.js';
import { createJsonRpcClient } from './jsonrpc.js';

it('answers a server request without confusing its ID with the client request', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: unknown[] = [];
  const detach = attachContentLengthReader(output, (frame) => frames.push(frame));
  const rpc = createJsonRpcClient({ input, output, onRequest: (method) => {
    expect(method).toBe('workspace/configuration');
    return [null];
  } });
  try {
    let finished = false;
    const reply = rpc.request('initialize', {}).then((value) => { finished = true; return value; });
    writeContentLengthMessage(input, { jsonrpc: '2.0', id: 1, method: 'workspace/configuration', params: { items: [{}] } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    expect(frames).toContainEqual({ jsonrpc: '2.0', id: 1, result: [null] });
    writeContentLengthMessage(input, { jsonrpc: '2.0', id: 1, result: { capabilities: {} } });
    expect(await reply).toEqual({ capabilities: {} });
  } finally { rpc.dispose(); detach(); input.destroy(); output.destroy(); }
});
