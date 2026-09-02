import { readOpenCodeGoCredential } from '../opencode-go-credentials.js';
import { buildResult, toUsageWindow } from '../utils/index.js';
import type { ManagedCredential } from '../credentials/providers.js';
import type { UsageWindow } from '../utils/index.js';

export const providerId = 'opencode-go';
export const providerName = 'OpenCode Go';
export const aliases = ['opencode-go'];

const patterns = {
  '5h': 'rollingUsage',
  weekly: 'weeklyUsage',
  monthly: 'monthlyUsage',
};

const captureNumber = (name: string, body: string): number | null => {
  const match = body.match(new RegExp(`["']?${name}["']?\\s*:\\s*["']?(-?\\d+(?:\\.\\d+)?)`));
  const value = match ? Number(match[1]) : null;
  return Number.isFinite(value) ? value : null;
};

export const parseOpenCodeGoUsage = (html: unknown, now = Date.now()): Record<string, UsageWindow> => {
  if (typeof html !== 'string') return {};
  const normalized = html.replaceAll('&quot;', '"').replaceAll('&#34;', '"').replaceAll('\\u0022', '"').replaceAll('\\"', '"');
  const windows: Record<string, UsageWindow> = {};
  for (const [key, field] of Object.entries(patterns)) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = normalized.match(new RegExp(`["']?${escaped}["']?\\s*:\\s*(?:\\$R\\[\\d+\\]\\s*=\\s*)?\\{([^{}]*)\\}`, 's'));
    const body = match?.[1];
    if (!body) continue;
    const usedPercent = captureNumber('usagePercent', body);
    const resetInSec = captureNumber('resetInSec', body);
    if (usedPercent === null || resetInSec === null) continue;
    windows[key] = toUsageWindow({
      usedPercent: Math.min(100, Math.max(0, usedPercent)),
      resetAt: now + Math.max(0, resetInSec) * 1000,
      windowSeconds: null,
    });
  }
  return windows;
};

export const fetchOpenCodeGoUsage = async (
  credential: ManagedCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, UsageWindow>> => {
  const { workspaceId, authCookie } = credential;
  if (!workspaceId || !authCookie) throw new Error('OpenCode Go credential is incomplete');
  const response = await fetchImpl(`https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      Cookie: `auth=${authCookie}`,
      'User-Agent': 'Piarium quota provider',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
    throw new Error('OpenCode Go authentication failed');
  }
  if (!response.ok) throw new Error(`OpenCode Go dashboard returned HTTP ${response.status}`);
  const windows = parseOpenCodeGoUsage(await response.text());
  if (Object.keys(windows).length === 0) throw new Error('OpenCode Go usage data could not be parsed');
  return windows;
};

export const isConfigured = () => Boolean(readOpenCodeGoCredential());

export const fetchQuota = async () => {
  const credential = readOpenCodeGoCredential();
  if (!credential) return buildResult({ providerId, providerName, ok: false, configured: false, error: 'Not configured' });
  try {
    const windows = await fetchOpenCodeGoUsage(credential);
    return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows } });
  } catch (error) {
    return buildResult({ providerId, providerName, ok: false, configured: true, error: error instanceof Error ? error.message : 'Request failed' });
  }
};
