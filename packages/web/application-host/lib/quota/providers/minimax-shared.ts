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
import type { UsageWindow } from '../utils/index.js';

// Status 3 indicates the window is not applicable for the current plan tier.
const WINDOW_STATUS_INACTIVE = 3;

const TEXT_MODELS = ['general', 'chat', 'text'];

type MiniMaxModel = Record<string, unknown>;

interface MiniMaxProviderOptions {
  aliases: string[];
  codingPlanUrl: string;
  providerId: string;
  providerName: string;
  tokenPlanUrl: string;
}

const pickChatModel = (modelRemains: unknown): MiniMaxModel | null => {
  if (!Array.isArray(modelRemains) || modelRemains.length === 0) return null;
  const models = modelRemains
    .map(asObject)
    .filter((model): model is MiniMaxModel => Boolean(model));
  if (models.length === 0) return null;

  const m3Candidate = models.find(
    (model) => typeof model.model_name === 'string'
      && /^minimax-m/i.test(model.model_name)
      && (toNumber(model.current_interval_total_count) ?? 0) > 0
  );
  if (m3Candidate) return m3Candidate;

  const textCandidate = models.find(
    (model) => typeof model.model_name === 'string' && TEXT_MODELS.includes(model.model_name.toLowerCase())
  );
  if (textCandidate) return textCandidate;

  const percentCandidate = models.find(
    (model) => typeof model.current_interval_remaining_percent === 'number'
  );
  if (percentCandidate) return percentCandidate;

  return models[0] ?? null;
};

const isUsablePayload = (payload: Record<string, unknown>): boolean => {
  const baseResp = asObject(payload.base_resp);
  if (baseResp && baseResp.status_code !== 0) return false;
  const rems = payload.model_remains;
  return Array.isArray(rems) && rems.length > 0;
};

const fetchEndpoint = async (url: string, apiKey: string): Promise<Record<string, unknown> | null> => {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) return null;
    const payload = asObject(await response.json());
    if (!payload) return null;
    if (!isUsablePayload(payload)) return null;
    return payload;
  } catch {
    return null;
  }
};

const coercePercent = (value: unknown): number | null => {
  const n = toNumber(value);
  return n !== null ? Math.max(0, Math.min(100, n)) : null;
};

/**
 * Check if a window (interval or weekly) is active for the current plan.
 * Status 3 means the window is not applicable (e.g. legacy plans without weekly limits).
 * When the status field is absent, default to active.
 */
const isWindowActive = (status: unknown): boolean => {
  const n = toNumber(status);
  return n === null || n !== WINDOW_STATUS_INACTIVE;
};

/**
 * Calculate window duration in seconds from API timestamps or remains_time.
 * MiniMax API returns remains_time in milliseconds (confirmed via live API testing:
 * 9664502 ms = 2.68h in a 5h window, consistent with remaining_percent).
 */
const calculateWindowSeconds = (
  startAt: number | null,
  resetAt: number | null,
  remainsTimeMs: number | null,
): number | null => {
  if (startAt && resetAt && resetAt > startAt) {
    return Math.floor((resetAt - startAt) / 1000);
  }
  if (remainsTimeMs && remainsTimeMs > 0) {
    return Math.floor(remainsTimeMs / 1000);
  }
  return null;
};

const calculateUsage = (model: MiniMaxModel, isTokenPlan: boolean) => {
  const intervalTotal = toNumber(model.current_interval_total_count);
  const intervalUsageRaw = toNumber(model.current_interval_usage_count);
  const intervalStartAt = toTimestamp(model.start_time);
  const intervalResetAt = toTimestamp(model.end_time);
  const intervalRemainsTime = toNumber(model.remains_time);
  const intervalRemainingPercent = coercePercent(model.current_interval_remaining_percent);

  const weeklyTotal = toNumber(model.current_weekly_total_count);
  const weeklyUsageRaw = toNumber(model.current_weekly_usage_count);
  const weeklyStartAt = toTimestamp(model.weekly_start_time);
  const weeklyResetAt = toTimestamp(model.weekly_end_time);
  const weeklyRemainsTime = toNumber(model.weekly_remains_time);
  const weeklyRemainingPercent = coercePercent(model.current_weekly_remaining_percent);

  let intervalUsedPercent = null;
  if (intervalRemainingPercent !== null) {
    intervalUsedPercent = 100 - intervalRemainingPercent;
  } else if (intervalTotal !== null && intervalTotal > 0 && intervalUsageRaw !== null) {
    const intervalUsed = isTokenPlan
      ? Math.max(0, intervalTotal - intervalUsageRaw)
      : intervalUsageRaw;
    intervalUsedPercent = Math.max(0, Math.min(100, (intervalUsed / intervalTotal) * 100));
  }

  let weeklyUsedPercent = null;
  if (weeklyRemainingPercent !== null) {
    weeklyUsedPercent = 100 - weeklyRemainingPercent;
  } else if (weeklyTotal !== null && weeklyTotal > 0 && weeklyUsageRaw !== null) {
    const weeklyUsed = isTokenPlan
      ? Math.max(0, weeklyTotal - weeklyUsageRaw)
      : weeklyUsageRaw;
    weeklyUsedPercent = Math.max(0, Math.min(100, (weeklyUsed / weeklyTotal) * 100));
  }

  const intervalWindowSeconds = calculateWindowSeconds(intervalStartAt, intervalResetAt, intervalRemainsTime);
  const weeklyWindowSeconds = calculateWindowSeconds(weeklyStartAt, weeklyResetAt, weeklyRemainsTime);

  return {
    intervalUsedPercent,
    intervalWindowSeconds,
    intervalResetAt,
    weeklyUsedPercent,
    weeklyWindowSeconds,
    weeklyResetAt,
  };
};

export const createMiniMaxCodingPlanProvider = ({
  providerId,
  providerName,
  aliases,
  tokenPlanUrl,
  codingPlanUrl,
}: MiniMaxProviderOptions) => {
  const isConfigured = () => {
    const auth = readAuthFile();
    const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
    return Boolean(entry?.key || entry?.token);
  };

  const fetchQuota = async () => {
    const auth = readAuthFile();
    const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
    const apiKey = typeof entry?.key === 'string'
      ? entry.key
      : typeof entry?.token === 'string'
        ? entry.token
        : null;

    if (!apiKey) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: false,
        error: 'Not configured',
      });
    }

    try {
      let payload = await fetchEndpoint(tokenPlanUrl, apiKey);
      let isTokenPlan = true;

      if (!payload) {
        payload = await fetchEndpoint(codingPlanUrl, apiKey);
        isTokenPlan = false;
      }

      if (!payload) {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: 'API returned no usable quota data',
        });
      }

      const model = pickChatModel(payload.model_remains);
      if (!model) {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: 'No model quota data available',
        });
      }

      const {
        intervalUsedPercent,
        intervalWindowSeconds,
        intervalResetAt,
        weeklyUsedPercent,
        weeklyWindowSeconds,
        weeklyResetAt,
      } = calculateUsage(model, isTokenPlan);

      const windows: Record<string, UsageWindow> = {
        '5h': toUsageWindow({
          usedPercent: intervalUsedPercent,
          windowSeconds: intervalWindowSeconds,
          resetAt: intervalResetAt,
        }),
      };

      // Only include the weekly window when the plan tier supports it.
      // Status 3 = not applicable (e.g. legacy Coding Plan without weekly limits).
      const weeklyActive = isWindowActive(model.current_weekly_status);
      const hasWeeklyData =
        weeklyActive &&
        (coercePercent(model.current_weekly_remaining_percent) !== null ||
          (toNumber(model.current_weekly_total_count) ?? 0) > 0);

      if (hasWeeklyData) {
        windows.weekly = toUsageWindow({
          usedPercent: weeklyUsedPercent,
          windowSeconds: weeklyWindowSeconds,
          resetAt: weeklyResetAt,
        });
      }

      return buildResult({
        providerId,
        providerName,
        ok: true,
        configured: true,
        usage: { windows },
      });
    } catch (error) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: error instanceof Error ? error.message : 'Request failed',
      });
    }
  };

  return {
    providerId,
    providerName,
    aliases,
    isConfigured,
    fetchQuota,
  };
};
