import { describe, expect, it, vi } from 'vitest';

import {
  createGlobalUiEventBroadcaster,
  createNotificationEmitterRuntime,
} from './emitter-runtime.js';

const createRuntime = (overrides = {}) => createNotificationEmitterRuntime({
  process: { stdout: { write: vi.fn() } },
  getDesktopNotifyEnabled: () => true,
  desktopNotifyPrefix: '[desktop-notify]',
  getUiNotificationClients: () => new Set(),
  getBroadcastGlobalUiEvent: () => null,
  ...overrides,
});

describe('notification emitter runtime', () => {
  it('broadcasts Pi events to every active notification SSE response', () => {
    const first = { write: vi.fn() };
    const second = { write: vi.fn() };
    const writeSseEvent = vi.fn((response, payload) => response.write(payload));
    const broadcast = createGlobalUiEventBroadcaster({
      sseClients: new Set([first, second]),
      writeSseEvent,
    });

    broadcast({ type: 'piarium:notification' });

    expect(writeSseEvent).toHaveBeenCalledTimes(2);
    expect(first.write).toHaveBeenCalledWith({ type: 'piarium:notification' });
    expect(second.write).toHaveBeenCalledWith({ type: 'piarium:notification' });
  });

  it('reports desktop delivery through the injected native callback', () => {
    const onDesktopNotification = vi.fn();
    const runtime = createRuntime({ onDesktopNotification });
    const payload = { title: 'Ready', body: 'Done' };

    expect(runtime.emitDesktopNotification(payload)).toBe(true);
    expect(onDesktopNotification).toHaveBeenCalledWith(payload);
  });

  it('reports stdout desktop delivery for legacy shells', () => {
    const write = vi.fn();
    const runtime = createRuntime({ process: { stdout: { write } } });

    expect(runtime.emitDesktopNotification({ title: 'Ready' })).toBe(true);
    expect(write).toHaveBeenCalledWith('[desktop-notify]{"title":"Ready"}\n');
  });

  it('marks UI broadcasts that were already delivered natively', () => {
    const broadcastGlobalUiEvent = vi.fn();
    const runtime = createRuntime({ getBroadcastGlobalUiEvent: () => broadcastGlobalUiEvent });

    runtime.broadcastUiNotification({ title: 'Ready' }, { desktopNotificationDelivered: true });

    expect(broadcastGlobalUiEvent).toHaveBeenCalledWith({
      type: 'piarium:notification',
      properties: {
        title: 'Ready',
        desktopNotificationDelivered: true,
        desktopStdoutActive: true,
      },
    });
  });
});
