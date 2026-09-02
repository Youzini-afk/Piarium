import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../pi-config/storage.js', () => ({
  readPiAuthFile: () => ({ crof: { key: 'test-token' } }),
}));

import { fetchQuota } from './crof.js';
import type { QuotaResult, UsageWindow } from '../utils/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const requireWindow = (result: QuotaResult, key: string): UsageWindow => {
  const window = result.usage?.windows[key];
  if (!window) throw new Error(`Expected quota window: ${key}`);
  return window;
};

const mockResponse = (body: unknown, init: Record<string, unknown> = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
  ...init,
});

describe('Crof quota provider', () => {
  it('reports credits balance as valueLabel with null percent', async () => {
    // Documented /usage_api/ response from https://crof.ai/docs.md
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockResponse({ usable_requests: 450, credits: 12.3456 }),
    ));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('crof');
    expect(requireWindow(result, 'credits').usedPercent).toBeNull();
    expect(requireWindow(result, 'credits').valueLabel).toBe('$12.35');
    expect(requireWindow(result, 'credits').windowSeconds).toBeNull();
    expect(requireWindow(result, 'credits').resetAt).toBeNull();
  });

  it('tolerates missing credits field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockResponse({ usable_requests: 0 }),
    ));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(requireWindow(result, 'credits').valueLabel).toBeUndefined();
    expect(requireWindow(result, 'credits').usedPercent).toBeNull();
  });

  it('parses numeric-string credits', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockResponse({ credits: '99.5' }),
    ));

    const result = await fetchQuota();

    expect(requireWindow(result, 'credits').valueLabel).toBe('$99.50');
  });

  it('maps 401 to session-expired error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('Session expired — please re-authenticate with CrofAI');
  });

  it('surfaces non-401 API errors with status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('API error: 503');
  });

  it('reports invalid-response on JSON parse failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid response from provider');
  });
});
