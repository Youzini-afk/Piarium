import { readPiAuthFile as readAuthFile } from '../../pi-config/storage.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  asObject,
} from '../utils/index.js';

const providerId = 'openai';
const providerName = 'OpenAI';
const aliases = ['openai', 'codex', 'chatgpt'];

export const fetchQuota = async () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const accessToken = entry?.access ?? entry?.token;

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
    const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
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
    const rateLimit = asObject(payload.rate_limit) ?? {};
    const primary = asObject(rateLimit.primary_window);
    const secondary = asObject(rateLimit.secondary_window);

    const windows: Record<string, ReturnType<typeof toUsageWindow>> = {};
    if (primary) {
      windows['5h'] = toUsageWindow({
        usedPercent: typeof primary.used_percent === 'number' ? primary.used_percent : null,
        windowSeconds: typeof primary.limit_window_seconds === 'number' ? primary.limit_window_seconds : null,
        resetAt: typeof primary.reset_at === 'number' ? primary.reset_at * 1000 : null
      });
    }
    if (secondary) {
      windows['weekly'] = toUsageWindow({
        usedPercent: typeof secondary.used_percent === 'number' ? secondary.used_percent : null,
        windowSeconds: typeof secondary.limit_window_seconds === 'number' ? secondary.limit_window_seconds : null,
        resetAt: typeof secondary.reset_at === 'number' ? secondary.reset_at * 1000 : null
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
