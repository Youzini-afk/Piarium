import type {
  PiAssistantMessage,
  PiSessionEntry,
  PiUsage,
} from '@piarium/protocol';

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
  const hasUsage = Object.values(values).some((value) => value > 0);
  if (!hasUsage) return undefined;
  const metrics: PiUsageMetric[] = [
    { key: 'input', value: values.input },
    { key: 'output', value: values.output },
    { key: 'reasoning', value: values.reasoning },
    { key: 'cacheRead', value: values.cacheRead },
    { key: 'cacheWrite', value: values.cacheWrite },
    { key: 'cacheWrite1h', value: values.cacheWrite1h },
  ].filter((metric) => metric.value > 0) as PiUsageMetric[];
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

export const aggregatePiUsage = (
  usages: readonly PiUsage[],
): PiUsage | undefined => {
  if (usages.length === 0) return undefined;
  let hasReasoning = false;
  let hasCacheWrite1h = false;
  const aggregate: PiUsage = {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
  };
  for (const usage of usages) {
    aggregate.cacheRead += positive(usage.cacheRead);
    aggregate.cacheWrite += positive(usage.cacheWrite);
    aggregate.input += positive(usage.input);
    aggregate.output += positive(usage.output);
    aggregate.totalTokens += positive(usage.totalTokens);
    aggregate.cost.cacheRead += positive(usage.cost?.cacheRead);
    aggregate.cost.cacheWrite += positive(usage.cost?.cacheWrite);
    aggregate.cost.input += positive(usage.cost?.input);
    aggregate.cost.output += positive(usage.cost?.output);
    aggregate.cost.total += positive(usage.cost?.total);
    if (usage.reasoning !== undefined) {
      hasReasoning = true;
      aggregate.reasoning = (aggregate.reasoning ?? 0) + positive(usage.reasoning);
    }
    if (usage.cacheWrite1h !== undefined) {
      hasCacheWrite1h = true;
      aggregate.cacheWrite1h = (aggregate.cacheWrite1h ?? 0) + positive(usage.cacheWrite1h);
    }
  }
  if (!hasReasoning) delete aggregate.reasoning;
  if (!hasCacheWrite1h) delete aggregate.cacheWrite1h;
  return aggregate;
};

export const assistantMessagesForTurn = (
  entries: readonly PiSessionEntry[],
  liveAssistant?: PiAssistantMessage,
): PiAssistantMessage[] => {
  const messages = entries.flatMap((entry) => (
    entry.type === 'message' && entry.message.role === 'assistant'
      ? [entry.message]
      : []
  ));
  if (liveAssistant) messages.push(liveAssistant);
  return messages;
};

export const aggregateAssistantUsage = (
  entries: readonly PiSessionEntry[],
  liveAssistant?: PiAssistantMessage,
): PiUsage | undefined => aggregatePiUsage(
  assistantMessagesForTurn(entries, liveAssistant).map((message) => message.usage),
);

export const latestAssistantTurnUsage = (
  entries: readonly PiSessionEntry[],
): PiUsage | undefined => {
  let turnStart = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === 'message' && entry.message.role === 'user') {
      turnStart = index + 1;
      break;
    }
  }
  return aggregateAssistantUsage(entries.slice(turnStart));
};
