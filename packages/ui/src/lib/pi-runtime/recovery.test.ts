import { describe, expect, test } from 'bun:test';
import type { RecoveryStatus } from '@piarium/protocol';
import {
  recoveryModeForStatus,
  recoveryModeFromPreference,
  supportsPiRecoveryAction,
} from './recovery';

describe('Pi recovery preference', () => {
  test('maps direct preferences to native recovery modes', () => {
    expect(recoveryModeFromPreference('conversation')).toBe('conversation');
    expect(recoveryModeFromPreference('both')).toBe('both');
  });

  test('leaves always-ask unresolved for the UI to prompt', () => {
    expect(recoveryModeFromPreference('ask')).toBeNull();
  });
});

describe('Pi recovery capabilities', () => {
  const status: RecoveryStatus = {
    actions: ['navigate', 'undo', 'redo'],
    available: true,
    issues: [],
    modes: ['conversation', 'both'],
    providers: [
      {
        actions: ['navigate', 'undo'],
        active: true,
        id: 'pi-native',
        modes: ['conversation'],
        name: 'Pi session tree',
      },
      {
        actions: ['navigate', 'redo'],
        active: true,
        id: 'workspace-history',
        modes: ['both'],
        name: 'Workspace history',
      },
    ],
  };

  test('requires one active provider to advertise both the action and mode', () => {
    expect(supportsPiRecoveryAction(status, 'navigate', 'conversation')).toBe(true);
    expect(supportsPiRecoveryAction(status, 'navigate', 'both')).toBe(true);
    expect(supportsPiRecoveryAction(status, 'undo', 'both')).toBe(false);
    expect(supportsPiRecoveryAction(status, 'redo', 'conversation')).toBe(false);
  });

  test('checks mode-free actions without relying on global unions', () => {
    expect(supportsPiRecoveryAction(status, 'redo')).toBe(true);
    expect(supportsPiRecoveryAction(status, 'checkpoint')).toBe(false);
    expect(supportsPiRecoveryAction(undefined, 'navigate', 'conversation')).toBe(false);
  });

  test('opens the chooser when a direct combined preference has no matching provider', () => {
    expect(recoveryModeForStatus('conversation', status)).toBe('conversation');
    expect(recoveryModeForStatus('both', status)).toBe('both');
    expect(recoveryModeForStatus('ask', status)).toBeNull();
    expect(recoveryModeForStatus('both', {
      ...status,
      providers: status.providers.map((provider) => ({
        ...provider,
        modes: provider.modes.filter((mode) => mode !== 'both'),
      })),
    })).toBeNull();
  });
});
