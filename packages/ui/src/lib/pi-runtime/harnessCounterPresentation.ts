import { HARNESS_MODEL_ROLES, type HarnessModelRole, type SessionStats } from '@piarium/protocol';

export interface HarnessModelSlotPresentation {
  calls: number;
  cost: number;
  slot: HarnessModelRole;
  totalTokens: number;
}

export interface HarnessCounterPresentation {
  cacheHitPercent?: number;
  outputBytes?: number;
  observationCalls?: number;
  toolErrors?: number;
  toolRetries?: number;
  modelSlots?: HarnessModelSlotPresentation[];
}

const nonNegative = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
);

export const projectHarnessCounters = (stats: SessionStats | undefined): HarnessCounterPresentation | null => {
  if (!stats) return null;
  const toolErrors = nonNegative(stats.toolErrors);
  const toolRetries = nonNegative(stats.toolRetries);
  const outputBytes = nonNegative(stats.outputBytes);
  const observationCalls = nonNegative(stats.observationCalls);
  const ratio = typeof stats.cacheHitRatio === 'number'
    && Number.isFinite(stats.cacheHitRatio)
    && stats.cacheHitRatio >= 0
    && stats.cacheHitRatio <= 1
    ? stats.cacheHitRatio
    : undefined;
  const modelSlots = HARNESS_MODEL_ROLES.flatMap((slot) => {
    const usage = stats.modelSlotUsage?.[slot];
    const calls = nonNegative(usage?.calls);
    const cost = nonNegative(usage?.cost);
    const totalTokens = nonNegative(usage?.tokens.total);
    if (calls === undefined || cost === undefined || totalTokens === undefined) return [];
    return [{ calls, cost, slot, totalTokens }];
  });
  if (toolErrors === undefined && toolRetries === undefined && outputBytes === undefined && observationCalls === undefined && ratio === undefined && modelSlots.length === 0) return null;
  return {
    ...(toolErrors === undefined ? {} : { toolErrors }),
    ...(toolRetries === undefined ? {} : { toolRetries }),
    ...(outputBytes === undefined ? {} : { outputBytes }),
    ...(observationCalls === undefined ? {} : { observationCalls }),
    ...(ratio === undefined ? {} : { cacheHitPercent: ratio * 100 }),
    ...(modelSlots.length === 0 ? {} : { modelSlots }),
  };
};

export const formatHarnessOutputBytes = (bytes: number, locale?: string): string => {
  if (bytes < 1024) return `${new Intl.NumberFormat(locale).format(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: value >= 10 ? 0 : 1 }).format(value)} ${units[index]}`;
};
