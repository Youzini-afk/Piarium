import { describe, expect, it, vi } from 'vitest';

import { createGlobalMessageStreamHub } from './global-hub.js';

function createHeldSseResponse(signal) {
  let releaseAbort;
  const abortReleased = new Promise((resolve) => {
    releaseAbort = resolve;
  });

  const response = {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (signal.aborted) {
              await abortReleased;
              const error = new Error('Aborted');
              error.name = 'AbortError';
              throw error;
            }

            return new Promise((_resolve, reject) => {
              signal.addEventListener('abort', async () => {
                await abortReleased;
                const error = new Error('Aborted');
                error.name = 'AbortError';
                reject(error);
              }, { once: true });
            });
          },
        };
      },
    },
  };

  return { response, releaseAbort };
}

function createOpenSseResponse(signal) {
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            return new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                const error = new Error('Aborted');
                error.name = 'AbortError';
                reject(error);
              }, { once: true });
            });
          },
        };
      },
    },
  };
}

function createSseResponse({ blocks = [] } = {}) {
  const encoder = new TextEncoder();
  let index = 0;

  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (index < blocks.length) {
              return { value: encoder.encode(blocks[index++]), done: false };
            }
            return { value: undefined, done: true };
          },
        };
      },
    },
  };
}

async function waitForAssertion(assertion) {
  const deadline = Date.now() + 1000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw lastError;
}

describe('createGlobalMessageStreamHub', () => {
  it('ignores stale disconnect callbacks after the hub is restarted', async () => {
    const statuses = [];
    let firstReleaseAbort = null;
    let fetchCalls = 0;

    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (_url, options) => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          const held = createHeldSseResponse(options.signal);
          firstReleaseAbort = held.releaseAbort;
          return held.response;
        }
        return createOpenSseResponse(options.signal);
      },
    });

    hub.subscribeStatus((status) => {
      statuses.push(status.type);
    });

    hub.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hub.isConnected()).toBe(true);

    hub.stop();
    hub.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hub.isConnected()).toBe(true);

    firstReleaseAbort();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hub.isConnected()).toBe(true);
    expect(statuses).toEqual(['connect', 'connect']);

    hub.stop();
  });

  it('continues fanout when an event subscriber throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'id: evt-1\ndata: {"type":"session.updated","properties":{}}\n\n',
        ],
      }),
    });

    hub.subscribeEvent(() => {
      throw new Error('subscriber failed');
    });
    hub.subscribeEvent((event) => {
      received.push(event.eventId);
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(received).toEqual(['evt-1']);
      });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      hub.stop();
      warnSpy.mockRestore();
    }
  });

  it('continues status fanout when a status subscriber throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse(),
    });

    hub.subscribeStatus(() => {
      throw new Error('status subscriber failed');
    });
    hub.subscribeStatus((status) => {
      received.push(status.type);
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(received).toContain('connect');
      });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      hub.stop();
      warnSpy.mockRestore();
    }
  });

  it('continues fanout when an async event subscriber rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received = [];
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 100,
      fetchImpl: async () => createSseResponse({
        blocks: [
          'id: evt-1\ndata: {"type":"session.updated","properties":{}}\n\n',
        ],
      }),
    });

    hub.subscribeEvent(async () => {
      throw new Error('async subscriber failed');
    });
    hub.subscribeEvent((event) => {
      received.push(event.eventId);
    });

    try {
      hub.start();
      await waitForAssertion(() => {
        expect(received).toEqual(['evt-1']);
      });
      await waitForAssertion(() => {
        expect(warnSpy).toHaveBeenCalled();
      });
    } finally {
      hub.stop();
      warnSpy.mockRestore();
    }
  });
});
