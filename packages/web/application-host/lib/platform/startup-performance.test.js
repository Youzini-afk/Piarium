import { afterEach, describe, expect, it, vi } from 'vitest';

import { recordStartupPerformance } from './startup-performance.js';

describe('startup performance diagnostics', () => {
  const previousValue = process.env.PIARIUM_STARTUP_PERF;

  afterEach(() => {
    if (previousValue === undefined) delete process.env.PIARIUM_STARTUP_PERF;
    else process.env.PIARIUM_STARTUP_PERF = previousValue;
    vi.restoreAllMocks();
  });

  it('is disabled by default', () => {
    delete process.env.PIARIUM_STARTUP_PERF;
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    recordStartupPerformance('pi-runtime.warmup.ready', { durationMs: 5 });

    expect(info).not.toHaveBeenCalled();
  });

  it('records only approved labels and numeric metadata', () => {
    process.env.PIARIUM_STARTUP_PERF = '1';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    recordStartupPerformance('pi-runtime.warmup.ready', {
      durationMs: 75,
      totalDurationMs: 100,
      attempt: 1,
      outcome: 'ready',
      routeClass: 'session-messages',
      sessionID: 'secret-session',
      directory: '/secret/directory',
      token: 'secret-token',
    });

    expect(info).toHaveBeenCalledOnce();
    const event = info.mock.calls[0][1];
    expect(event).toMatchObject({
      phase: 'pi-runtime.warmup.ready',
      durationMs: 75,
      totalDurationMs: 100,
      attempt: 1,
      outcome: 'ready',
      routeClass: 'session-messages',
    });
    expect(Number.isFinite(event.at)).toBe(true);
    expect(JSON.stringify(event)).not.toContain('secret');
  });

  it('rejects unknown phases and invalid field values', () => {
    process.env.PIARIUM_STARTUP_PERF = 'true';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    recordStartupPerformance('secret.phase', { durationMs: 1 });
    recordStartupPerformance('pi-runtime.warmup.error', {
      durationMs: -1,
      attempt: 1.5,
      outcome: 'secret-outcome',
      routeClass: 'secret-route',
    });

    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0][1]).toEqual(expect.objectContaining({
      phase: 'pi-runtime.warmup.error',
    }));
    expect(info.mock.calls[0][1]).not.toHaveProperty('durationMs');
    expect(info.mock.calls[0][1]).not.toHaveProperty('attempt');
    expect(info.mock.calls[0][1]).not.toHaveProperty('outcome');
    expect(info.mock.calls[0][1]).not.toHaveProperty('routeClass');
  });
});
