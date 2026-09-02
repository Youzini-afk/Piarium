/**
 * Zhipu AI Coding Plan quota fetch
 *
 * API: https://open.bigmodel.cn/api/monitor/usage/quota/limit
 *
 * Response limits:
 * - TOKENS_LIMIT: Token usage (5-hour rolling window)
 * - TIME_LIMIT: MCP tools usage (monthly window)
 *
 * @typedef {Object} TokensLimit
 * @property {string} type - 'TOKENS_LIMIT'
 * @property {number} [unit]
 * @property {number} [number]
 * @property {number} [nextResetTime]
 * @property {number} [percentage]
 *
 * @typedef {Object} McpToolsTimeLimit
 * @property {string} type - 'TIME_LIMIT'
 * @property {number} [unit]
 * @property {number} [number]
 * @property {number} [usage]
 * @property {number} [currentValue]
 * @property {number} [remaining]
 * @property {number} [percentage]
 * @property {number} [nextResetTime]
 * @property {Array<{modelCode: string, usage: number}>} [usageDetails]
 */
import { readPiAuthFile as readAuthFile, readPiConfigLayers as readConfigLayers } from '../../pi-config/storage.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  resolveWindowSeconds,
  normalizeTimestamp,
  asObject,
} from '../utils/index.js';
import type { UsageWindow } from '../utils/index.js';

export const providerId = 'zhipuai-coding-plan';
export const providerName = 'Zhipu AI Coding Plan';
const aliases = ['zhipuai-coding-plan', 'zhipuai', 'zhipu'];

function getApiKey(): string | null {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const apiKeyFromAuth = typeof entry?.key === 'string'
    ? entry.key
    : typeof entry?.token === 'string'
      ? entry.token
      : null;

  if (apiKeyFromAuth) {
    return apiKeyFromAuth;
  }

  try {
    const { mergedConfig } = readConfigLayers(undefined);
    const providers = asObject(mergedConfig.providers);

    for (const alias of aliases) {
      const providerConfig = asObject(providers?.[alias]);
      if (typeof providerConfig?.apiKey === 'string' && providerConfig.apiKey.trim()) {
        return providerConfig.apiKey.trim();
      }
    }
  } catch {
    // Ignore config read errors; the provider will be treated as not configured.
  }

  return null;
}

export const isConfigured = () => {
  return Boolean(getApiKey());
};

export const fetchQuota = async () => {
  const apiKey = getApiKey();

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
    const response = await fetch('https://open.bigmodel.cn/api/monitor/usage/quota/limit', {
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
    const data = asObject(payload.data);
    const limits = Array.isArray(data?.limits)
      ? data.limits.map(asObject).filter((limit): limit is Record<string, unknown> => Boolean(limit))
      : [];

    const tokensLimit = limits.find((limit) => limit?.type === 'TOKENS_LIMIT');
    const mcpToolsTimeLimit = limits.find((limit) => limit?.type === 'TIME_LIMIT');

    const windows: Record<string, UsageWindow> = {};

    // Handle TOKENS_LIMIT (5-hour window for token usage)
    if (tokensLimit) {
      const windowSeconds = resolveWindowSeconds(tokensLimit);
      const resetAt = tokensLimit?.nextResetTime ? normalizeTimestamp(tokensLimit.nextResetTime) : null;
      const usedPercent = typeof tokensLimit?.percentage === 'number' ? tokensLimit.percentage : null;

      windows['Tokens'] = toUsageWindow({
        usedPercent,
        windowSeconds,
        resetAt
      });
    }

    // Handle TIME_LIMIT (MCP tools monthly window)
    if (mcpToolsTimeLimit) {
      // TIME_LIMIT unit=5 means 1 month (30 days)
      const monthSeconds = 30 * 24 * 60 * 60;
      const resetAt = mcpToolsTimeLimit?.nextResetTime ? normalizeTimestamp(mcpToolsTimeLimit.nextResetTime) : null;
      const usedPercent = typeof mcpToolsTimeLimit?.percentage === 'number' ? mcpToolsTimeLimit.percentage : null;

      windows['MCP Tools'] = toUsageWindow({
        usedPercent,
        windowSeconds: monthSeconds,
        resetAt
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
