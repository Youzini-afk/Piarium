import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../pi-config/storage.js', () => ({
  readPiAuthFile: () => ({ openai: { access: 'test-token' } }),
}));

import { fetchQuota } from './codex.js';
import type { QuotaResult, UsageWindow } from '../utils/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const requireWindow = (result: QuotaResult, key: string): UsageWindow => {
  const window = result.usage?.windows[key];
  if (!window) throw new Error(`Expected quota window: ${key}`);
  return window;
};

const mockUsage = (rateLimit: unknown) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ rate_limit: rateLimit }),
  }));
};

describe('Codex quota windows', () => {
  it('labels a weekly-only primary window from its duration', async () => {
    mockUsage({
      primary_window: {
        used_percent: 3,
        limit_window_seconds: 604800,
        reset_at: 1784491827,
      },
      secondary_window: null,
    });

    const result = await fetchQuota();

    expect(requireWindow(result, 'weekly').usedPercent).toBe(3);
    expect(result.usage?.windows['5h']).toBeUndefined();
  });

  it('labels five-hour and weekly windows from their durations', async () => {
    mockUsage({
      primary_window: { used_percent: 10, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 20, limit_window_seconds: 604800 },
    });

    const result = await fetchQuota();

    expect(requireWindow(result, '5h').usedPercent).toBe(10);
    expect(requireWindow(result, 'weekly').usedPercent).toBe(20);
  });

  it('surfaces spend_control individual limit for business accounts', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        plan_type: 'business',
        rate_limit: null,
        credits: { has_credits: true, unlimited: false, balance: null },
        spend_control: {
          individual_limit: {
            limit: '7500',
            used: '2674.8724080324173',
            remaining: '4825.127591967583',
            used_percent: 36,
            remaining_percent: 64
          }
        }
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(requireWindow(result, 'credits').usedPercent).toBe(36);
    expect(requireWindow(result, 'credits').valueLabel).toBe('2675 / 7500 used');
    expect(fetchMock).toHaveBeenCalled();
  });
});
