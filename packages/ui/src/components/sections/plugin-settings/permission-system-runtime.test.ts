import { describe, expect, test } from 'bun:test';
import type { PiCommandDescriptor } from '@piarium/protocol';
import {
  buildPermissionSystemCommand,
  permissionSystemCommandObserved,
  permissionSystemRuntimeState,
} from './permission-system-runtime';

const command = (name: string): PiCommandDescriptor => ({
  name,
  source: 'extension',
  sourceInfo: { origin: 'top-level', path: name, scope: 'user', source: name },
});

describe('permission-system runtime command adapter', () => {
  test('observes only the native permission-system command', () => {
    expect(permissionSystemCommandObserved([command('/permission-system')])).toBe(true);
    expect(permissionSystemCommandObserved([command('permissions:status')])).toBe(false);
  });

  test('dispatches the exact native active-settings command', () => {
    expect(buildPermissionSystemCommand()).toBe('/permission-system show');
  });

  test('distinguishes session, loading, failure, and observation states', () => {
    expect(permissionSystemRuntimeState({ hasActiveSession: false, commandsChecked: false, commandsFailed: false, commandObserved: true })).toBe('no-session');
    expect(permissionSystemRuntimeState({ hasActiveSession: true, commandsChecked: false, commandsFailed: false, commandObserved: false })).toBe('loading');
    expect(permissionSystemRuntimeState({ hasActiveSession: true, commandsChecked: true, commandsFailed: true, commandObserved: false })).toBe('failure');
    expect(permissionSystemRuntimeState({ hasActiveSession: true, commandsChecked: true, commandsFailed: false, commandObserved: false })).toBe('not-observed');
    expect(permissionSystemRuntimeState({ hasActiveSession: true, commandsChecked: true, commandsFailed: false, commandObserved: true })).toBe('available');
  });
});
