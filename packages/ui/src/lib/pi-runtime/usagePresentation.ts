import type { PiSessionEntry, PiUsage } from '@piarium/protocol';

export type PiUsageMetricKey =
  | 'input'
  | 'output'
  | 'reasoning'
  | 'cacheRead'
  | 'cacheWrite'
  | 'cacheWrite1h';

export interface PiUsageMetric {
  key: PiUsageMetricKey;
  value: number;
}

export interface PiUsagePresentation {
  cacheHitPercent?: number;
  metrics: PiUsageMetric[];
  total?: number;
  values: {
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h: number;
    input: number;
    output: number;
    reasoning: number;
    total: number;
  };
}

const positive = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
);

export const projectPiUsagePresentation = (
  usage: PiUsage | undefined,
): PiUsagePresentation | undefined => {
  if (!usage) return undefined;
  const values = {
    cacheRead: positive(usage.cacheRead),
    cacheWrite: positive(usage.cacheWrite),
    cacheWrite1h: positive(usage.cacheWrite1h),
    input: positive(usage.input),
    output: positive(usage.output),
    reasoning: positive(usage.reasoning),
    total: positive(usage.totalTokens),
  };
  const metrics: PiUsageMetric[] = [
    { key: 'input', value: values.input },
    { key: 'output', value: values.output },
    { key: 'reasoning', value: values.reasoning },
    { key: 'cacheRead', value: values.cacheRead },
    { key: 'cacheWrite', value: values.cacheWrite },
    { key: 'cacheWrite1h', value: values.cacheWrite1h },
  ].filter((metric) => metric.value > 0) as PiUsageMetric[];
  if (metrics.length === 0 && values.total === 0) return undefined;
  const cacheInput = values.input + values.cacheRead + values.cacheWrite;
  const cacheReported = values.cacheRead > 0 || values.cacheWrite > 0;
  return {
    ...(cacheReported && cacheInput > 0
      ? { cacheHitPercent: (values.cacheRead / cacheInput) * 100 }
      : {}),
    metrics,
    ...(values.total > 0 ? { total: values.total } : {}),
    values,
  };
};

export const latestAssistantUsage = (
  entries: readonly PiSessionEntry[],
): PiUsage | undefined => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type === 'message'
      && entry.message.role === 'assistant'
    ) return entry.message.usage;
  }
  return undefined;
};
