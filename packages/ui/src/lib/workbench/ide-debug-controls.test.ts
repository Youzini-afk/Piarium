import { describe, expect, test } from 'vitest';
import { ideDebugControlAvailability } from './ide-debug-controls';

const status = (value: 'absent' | 'starting' | 'running' | 'paused' | 'stopped' | 'failed') => ({
  status: value,
  workspaceId: 'workspace',
} as const);

describe('IDE debug control availability', () => {
  test('waits for the initial authoritative status before enabling actions', () => {
    expect(ideDebugControlAvailability(null)).toEqual({
      canContinue: false,
      canStart: false,
      canStep: false,
      canStop: false,
    });
  });

  test('allows a new session when none exists or the previous session ended', () => {
    for (const value of ['absent', 'stopped', 'failed'] as const) {
      expect(ideDebugControlAvailability(status(value)).canStart).toBe(true);
    }
  });

  test('limits continue and step controls to a paused session', () => {
    expect(ideDebugControlAvailability(status('running'))).toEqual({
      canContinue: false,
      canStart: false,
      canStep: false,
      canStop: true,
    });
    expect(ideDebugControlAvailability(status('paused'))).toEqual({
      canContinue: true,
      canStart: false,
      canStep: true,
      canStop: true,
    });
  });
});
