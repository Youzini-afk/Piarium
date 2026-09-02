import { readPiAuthFile as readAuthFile } from '../../pi-config/storage.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
  asObject,
} from '../utils/index.js';

const NANO_GPT_DAILY_WINDOW_SECONDS = 86400;

export const providerId = 'nano-gpt';
export const providerName = 'NanoGPT';
const aliases = ['nano-gpt', 'nanogpt', 'nano_gpt'];

export const isConfigured = () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.key || entry?.token);
};

export const fetchQuota = async () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const apiKey = entry?.key ?? entry?.token;

  if (!apiKey) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const response = await fetch('https://nano-gpt.com/api/subscription/v1/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`
      });
    }

    const payload = asObject(await response.json()) ?? {};
    const windows: Record<string, ReturnType<typeof toUsageWindow>> = {};
    const period = asObject(payload.period);
    const daily = asObject(payload.daily);
    const monthly = asObject(payload.monthly);
    const state = typeof payload.state === 'string' ? payload.state : 'active';

    if (daily) {
      let usedPercent = null;
      const percentUsed = daily?.percentUsed;
      if (typeof percentUsed === 'number') {
        usedPercent = Math.max(0, Math.min(100, percentUsed * 100));
      } else {
        const used = toNumber(daily?.used);
        const dailyLimits = asObject(daily.limits);
        const limit = toNumber(daily.limit ?? dailyLimits?.daily);
        if (used !== null && limit !== null && limit > 0) {
          usedPercent = Math.max(0, Math.min(100, (used / limit) * 100));
        }
      }
      const resetAt = toTimestamp(daily?.resetAt);
      const valueLabel = state !== 'active' ? `(${state})` : null;
      windows['daily'] = toUsageWindow({
        usedPercent,
        windowSeconds: NANO_GPT_DAILY_WINDOW_SECONDS,
        resetAt,
        valueLabel
      });
    }

    if (monthly) {
      let usedPercent = null;
      const percentUsed = monthly?.percentUsed;
      if (typeof percentUsed === 'number') {
        usedPercent = Math.max(0, Math.min(100, percentUsed * 100));
      } else {
        const used = toNumber(monthly?.used);
        const monthlyLimits = asObject(monthly.limits);
        const limit = toNumber(monthly.limit ?? monthlyLimits?.monthly);
        if (used !== null && limit !== null && limit > 0) {
          usedPercent = Math.max(0, Math.min(100, (used / limit) * 100));
        }
      }
      const resetAt = toTimestamp(monthly.resetAt ?? period?.currentPeriodEnd);
      const valueLabel = state !== 'active' ? `(${state})` : null;
      windows['monthly'] = toUsageWindow({
        usedPercent,
        windowSeconds: null,
        resetAt,
        valueLabel
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows }
    });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};
