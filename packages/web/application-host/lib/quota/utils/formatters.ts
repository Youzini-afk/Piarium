type TimestampValue = Date | number | string;

export const formatResetTime = (timestamp: TimestampValue): string | null => {
  try {
    const resetDate = new Date(timestamp);
    if (!Number.isFinite(resetDate.getTime())) {
      return null;
    }

    const now = new Date();
    const isToday = resetDate.toDateString() === now.toDateString();

    if (isToday) {
      return resetDate.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit'
      });
    }

    return resetDate.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit'
    });
  } catch {
    return null;
  }
};

export const calculateResetAfterSeconds = (resetAt: TimestampValue | null | undefined): number | null => {
  if (!resetAt) return null;
  const resetAtTime = new Date(resetAt).getTime();
  if (!Number.isFinite(resetAtTime)) return null;
  const delta = Math.floor((resetAtTime - Date.now()) / 1000);
  return delta < 0 ? 0 : delta;
};

export interface UsageWindow {
  remainingPercent: number | null;
  resetAfterFormatted: string | null;
  resetAfterSeconds: number | null;
  resetAt: TimestampValue | null | undefined;
  resetAtFormatted: string | null;
  usedPercent: number | null;
  valueLabel?: string | null | undefined;
  windowSeconds: number | null;
}

export interface ModelQuotaUsage {
  windows: Record<string, UsageWindow>;
}

export interface QuotaUsage {
  models?: Record<string, ModelQuotaUsage>;
  windows: Record<string, UsageWindow>;
}

export interface QuotaResult {
  configured: boolean;
  error?: unknown;
  fetchedAt: number;
  ok: boolean;
  providerId: string;
  providerName: string;
  usage: QuotaUsage | null;
}

export interface QuotaProvider {
  fetchQuota: () => Promise<QuotaResult>;
  isConfigured: () => boolean;
  providerId: string;
  providerName: string;
}

export const toUsageWindow = ({ usedPercent, windowSeconds, resetAt, valueLabel }: {
  resetAt?: TimestampValue | null | undefined;
  usedPercent: number | null;
  valueLabel?: string | null | undefined;
  windowSeconds?: number | null | undefined;
}): UsageWindow => {
  const resetAfterSeconds = calculateResetAfterSeconds(resetAt);
  const resetFormatted = resetAt ? formatResetTime(resetAt) : null;
  return {
    usedPercent,
    remainingPercent: usedPercent !== null ? Math.max(0, 100 - usedPercent) : null,
    windowSeconds: windowSeconds ?? null,
    resetAfterSeconds,
    resetAt,
    resetAtFormatted: resetFormatted,
    resetAfterFormatted: resetFormatted,
    ...(valueLabel ? { valueLabel } : {})
  };
};

export const buildResult = ({ providerId, providerName, ok, configured, usage, error }: {
  configured: boolean;
  error?: unknown;
  ok: boolean;
  providerId: string;
  providerName: string;
  usage?: QuotaUsage;
}): QuotaResult => ({
  providerId,
  providerName,
  ok,
  configured,
  usage: usage ?? null,
  ...(error ? { error } : {}),
  fetchedAt: Date.now()
});

export const durationToLabel = (duration: number | null | undefined, unit: string | null | undefined): string => {
  if (!duration || !unit) return 'limit';
  if (unit === 'TIME_UNIT_MINUTE') return `${duration}m`;
  if (unit === 'TIME_UNIT_HOUR') return `${duration}h`;
  if (unit === 'TIME_UNIT_DAY') return `${duration}d`;
  return 'limit';
};

export const durationToSeconds = (duration: number | null | undefined, unit: string | null | undefined): number | null => {
  if (!duration || !unit) return null;
  if (unit === 'TIME_UNIT_MINUTE') return duration * 60;
  if (unit === 'TIME_UNIT_HOUR') return duration * 3600;
  if (unit === 'TIME_UNIT_DAY') return duration * 86400;
  return null;
};

export const formatMoney = (value: unknown): string | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value.toFixed(2);
};
