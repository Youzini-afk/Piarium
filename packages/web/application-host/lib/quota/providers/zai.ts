import { readPiAuthFile as readAuthFile } from '../../pi-config/storage.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  resolveWindowSeconds,
  resolveWindowLabel,
  normalizeTimestamp,
  asObject,
} from '../utils/index.js';

export const providerId = 'zai-coding-plan';
export const providerName = 'z.ai';
const aliases = ['zai-coding-plan', 'zai', 'z.ai'];

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
    const response = await fetch('https://api.z.ai/api/monitor/usage/quota/limit', {
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
    const data = asObject(payload.data) ?? {};
    const limits = Array.isArray(data.limits) ? data.limits : [];
    const windows: Record<string, ReturnType<typeof toUsageWindow>> = {};
    for (const tokensLimit of limits
      .map(asObject)
      .filter((limit): limit is Record<string, unknown> => Boolean(limit) && limit?.type === 'TOKENS_LIMIT')) {
      const windowSeconds = resolveWindowSeconds(tokensLimit);
      const windowLabel = resolveWindowLabel(windowSeconds);
      const resetAt = tokensLimit?.nextResetTime ? normalizeTimestamp(tokensLimit.nextResetTime) : null;
      const usedPercent = typeof tokensLimit?.percentage === 'number' ? tokensLimit.percentage : null;

      windows[windowLabel] = toUsageWindow({
        usedPercent,
        windowSeconds,
        resetAt
      });
    }

    const mcpToolsTimeLimit = limits.map(asObject).find((limit) => limit?.type === 'TIME_LIMIT');
    if (mcpToolsTimeLimit) {
      windows['MCP Tools'] = toUsageWindow({
        usedPercent: typeof mcpToolsTimeLimit.percentage === 'number' ? mcpToolsTimeLimit.percentage : null,
        windowSeconds: 30 * 24 * 60 * 60,
        resetAt: mcpToolsTimeLimit.nextResetTime ? normalizeTimestamp(mcpToolsTimeLimit.nextResetTime) : null
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
