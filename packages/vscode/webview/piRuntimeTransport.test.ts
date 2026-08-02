import assert from 'node:assert/strict';
import { test } from 'node:test';

test('VS Code runtime transport carries frames and close state over postMessage', async () => {
  const originalWindow = globalThis.window;
  const originalAcquire = (globalThis as typeof globalThis & { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
  const windowTarget = new EventTarget();
  const sent: unknown[] = [];
  try {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: windowTarget,
    });
    Object.defineProperty(globalThis, 'acquireVsCodeApi', {
      configurable: true,
      value: () => ({
        getState: () => undefined,
        postMessage: (message: unknown) => sent.push(message),
        setState: () => undefined,
      }),
    });
    const { VSCodeRuntimeTransport } = await import(`./piRuntimeTransport?test-${Date.now()}`);
    const received: string[] = [];
    const closes: Array<string | undefined> = [];
    const transport = new VSCodeRuntimeTransport();
    transport.start({
      close: (error?: Error) => closes.push(error?.message),
      message: (frame: string) => received.push(frame),
    });

    transport.send('{"request":true}');
    assert.deepEqual(sent, [{ frame: '{"request":true}', type: 'piarium:runtime:frame' }]);
    windowTarget.dispatchEvent(new MessageEvent('message', {
      data: { frame: '{"response":true}', type: 'piarium:runtime:frame' },
    }));
    assert.deepEqual(received, ['{"response":true}']);
    windowTarget.dispatchEvent(new MessageEvent('message', {
      data: { error: 'host stopped', type: 'piarium:runtime:closed' },
    }));
    assert.deepEqual(closes, ['host stopped']);
    assert.throws(() => transport.send('late'), /not open/);
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, 'acquireVsCodeApi', { configurable: true, value: originalAcquire });
  }
});
