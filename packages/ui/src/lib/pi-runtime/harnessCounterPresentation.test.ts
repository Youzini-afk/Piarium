import { describe, expect, it } from 'vitest';
import type { SessionStats } from '@piarium/protocol';
import { formatHarnessOutputBytes, projectHarnessCounters } from './harnessCounterPresentation';

const stats = (overrides: Partial<SessionStats> = {}): SessionStats => ({
  sessionId: 'session-1',
  cost: 0,
  tokens: { input: 20, output: 10, cacheRead: 80, cacheWrite: 0, total: 110 },
  totalMessages: 2,
  toolCalls: 1,
  toolResults: 1,
  assistantMessages: 1,
  userMessages: 1,
  ...overrides,
});

describe('harness counter presentation', () => {
  it('stays absent for runtimes that do not publish Harness counters', () => {
    expect(projectHarnessCounters(stats())).toBeNull();
  });

  it('projects zero values and cache ratio without inventing missing metrics', () => {
    expect(projectHarnessCounters(stats({
      toolErrors: 0,
      toolRetries: 2,
      outputBytes: 1536,
      cacheHitRatio: 0.8,
    }))).toEqual({ toolErrors: 0, toolRetries: 2, outputBytes: 1536, cacheHitPercent: 80 });
  });

  it('formats byte totals with binary units', () => {
    expect(formatHarnessOutputBytes(512, 'en-US')).toBe('512 B');
    expect(formatHarnessOutputBytes(1536, 'en-US')).toBe('1.5 KiB');
  });
});
