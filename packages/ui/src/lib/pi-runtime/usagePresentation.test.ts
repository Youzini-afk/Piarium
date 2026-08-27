import { describe, expect, test } from 'bun:test';
import type { PiSessionEntry, PiUsage } from '@piarium/protocol';
import {
  latestAssistantUsage,
  projectPiUsagePresentation,
} from './usagePresentation';

const usage = (update: Partial<PiUsage> = {}): PiUsage => ({
  cacheRead: 0,
  cacheWrite: 0,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  input: 0,
  output: 0,
  totalTokens: 0,
  ...update,
});

describe('Pi usage presentation', () => {
  test('shows only positive upstream fields and keeps the provider total authoritative', () => {
    const result = projectPiUsagePresentation(usage({
      cacheRead: 8_000,
      input: 2_000,
      output: 500,
      totalTokens: 10_500,
    }));
    expect(result?.metrics).toEqual([
      { key: 'input', value: 2_000 },
      { key: 'output', value: 500 },
      { key: 'cacheRead', value: 8_000 },
    ]);
    expect(result?.total).toBe(10_500);
    expect(result?.cacheHitPercent).toBe(80);
  });

  test('keeps optional reasoning and one-hour cache writes without inventing missing fields', () => {
    expect(projectPiUsagePresentation(usage({
      cacheWrite: 20,
      cacheWrite1h: 12,
      reasoning: 30,
      totalTokens: 50,
    }))?.metrics).toEqual([
      { key: 'reasoning', value: 30 },
      { key: 'cacheWrite', value: 20 },
      { key: 'cacheWrite1h', value: 12 },
    ]);
    expect(projectPiUsagePresentation(usage())).toBeUndefined();
  });

  test('selects the latest assistant usage instead of a later tool or summary usage', () => {
    const assistantUsage = usage({ input: 10, output: 4, totalTokens: 14 });
    const laterUsage = usage({ input: 999, totalTokens: 999 });
    const entries: PiSessionEntry[] = [
      {
        id: 'assistant',
        message: {
          api: 'messages',
          content: [],
          model: 'model',
          provider: 'provider',
          role: 'assistant',
          stopReason: 'stop',
          timestamp: 1,
          usage: assistantUsage,
        },
        parentId: null,
        timestamp: '1',
        type: 'message',
      },
      {
        details: {},
        firstKeptEntryId: 'assistant',
        id: 'compaction',
        parentId: 'assistant',
        summary: 'summary',
        timestamp: '2',
        tokensBefore: 999,
        type: 'compaction',
        usage: laterUsage,
      },
    ];
    expect(latestAssistantUsage(entries)).toBe(assistantUsage);
  });
});
