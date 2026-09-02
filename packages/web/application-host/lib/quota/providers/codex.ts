import { readPiAuthFile as readAuthFile } from '../../pi-config/storage.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
  resolveWindowLabel,
  formatMoney,
  asObject,
} from '../utils/index.js';
import type { UsageWindow } from '../utils/index.js';

export const providerId = 'codex';
export const providerName = 'Codex';
const aliases = ['openai', 'codex', 'chatgpt'];

export const isConfigured = () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.access || entry?.token);
};

export const fetchQuota = async () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const accessToken = entry?.access ?? entry?.token;
  const accountId = typeof entry?.accountId === 'string' ? entry.accountId : null;

  if (!accessToken) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {})
    };
    const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET',
      headers
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: response.status === 401
          ? 'Session expired \u2014 please re-authenticate with OpenAI'
          : `API error: ${response.status}`
      });
    }

    const payload = asObject(await response.json()) ?? {};
    const rateLimit = asObject(payload.rate_limit) ?? {};
    const primary = asObject(rateLimit.primary_window);
    const secondary = asObject(rateLimit.secondary_window);
    const credits = asObject(payload.credits);

    const windows: Record<string, UsageWindow> = {};
    if (primary) {
      const windowSeconds = toNumber(primary.limit_window_seconds);
      windows[resolveWindowLabel(windowSeconds)] = toUsageWindow({
        usedPercent: toNumber(primary.used_percent),
        windowSeconds,
        resetAt: toTimestamp(primary.reset_at)
      });
    }
    if (secondary) {
      const windowSeconds = toNumber(secondary.limit_window_seconds);
      windows[resolveWindowLabel(windowSeconds)] = toUsageWindow({
        usedPercent: toNumber(secondary.used_percent),
        windowSeconds,
        resetAt: toTimestamp(secondary.reset_at)
      });
    }
    if (credits) {
      const balance = toNumber(credits.balance);
      const unlimited = Boolean(credits.unlimited);
      const label = unlimited
        ? 'Unlimited'
        : balance !== null
          ? `$${formatMoney(balance)}`
          : null;
      windows.credits_balance = toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: label
      });
    }

    // Business/enterprise accounts expose a dollar spend cap under
    // `spend_control.individual_limit`. Surface it as an additive `credits`
    // window so existing consumers keep working.
    const spendControl = asObject(payload.spend_control);
    const spendLimit = asObject(spendControl?.individual_limit);
    if (spendLimit) {
      const used = toNumber(spendLimit.used);
      const limit = toNumber(spendLimit.limit);
      const valueLabel = used !== null && limit !== null
        ? `${used.toFixed(0)} / ${limit.toFixed(0)} used`
        : null;
      windows.credits = toUsageWindow({
        usedPercent: toNumber(spendLimit.used_percent),
        windowSeconds: null,
        resetAt: null,
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
