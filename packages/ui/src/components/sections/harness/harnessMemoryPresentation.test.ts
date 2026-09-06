import { describe, expect, test } from 'bun:test';
import type { HarnessMemoryRuntimeState } from '@piarium/protocol';
import {
  createHarnessMemoryModeMutation,
  projectHarnessMemoryPresentation,
  resolveHarnessMemoryModeForUi,
  withHarnessMemoryMode,
} from './harnessMemoryPresentation';

describe('harness memory presentation', () => {
  test('projects effective mode, scope, and the latest failure', () => {
    const memory: HarnessMemoryRuntimeState = {
      configuredMode: 'assist',
      effectiveMode: 'takeover',
      lastFailure: { at: 10, message: 'provider unavailable', phase: 'keeper' },
      overrideMode: 'takeover',
    };

    expect(projectHarnessMemoryPresentation(memory)).toEqual({
      configuredMode: 'assist',
      effectiveMode: 'takeover',
      failure: memory.lastFailure,
      overrideMode: 'takeover',
    });
    expect(projectHarnessMemoryPresentation({
      configuredMode: 'assist',
      effectiveMode: 'assist',
    }, 'off')).toEqual({
      configuredMode: 'assist',
      effectiveMode: 'assist',
      overrideMode: 'off',
    });
  });

  test('builds the session feature mutation for each selection', () => {
    expect(createHarnessMemoryModeMutation('inherit')).toEqual({
      mode: 'inherit',
      type: 'memory.mode.set',
    });
    expect(createHarnessMemoryModeMutation('off')).toEqual({
      mode: 'off',
      type: 'memory.mode.set',
    });
  });

  test('migrates shadow mode while retaining unknown memory and harness fields', () => {
    const harness = {
      memory: { shadowMode: true, unknownPolicy: { keep: true } },
      unknownHarness: ['keep'],
    };

    expect(withHarnessMemoryMode(harness, 'assist')).toEqual({
      memory: { mode: 'assist', unknownPolicy: { keep: true } },
      unknownHarness: ['keep'],
    });
  });

  test('exposes malformed persisted settings so the UI can repair them', () => {
    expect(resolveHarnessMemoryModeForUi({ mode: 'unexpected' })).toEqual({
      error: 'harness.memory.mode must be one of: off, assist, takeover',
      mode: null,
    });
  });
});
