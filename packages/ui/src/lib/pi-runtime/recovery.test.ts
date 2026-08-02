import { describe, expect, test } from 'bun:test';
import { recoveryModeFromPreference } from './recovery';

describe('Pi recovery preference', () => {
  test('maps direct preferences to native recovery modes', () => {
    expect(recoveryModeFromPreference('conversation')).toBe('conversation');
    expect(recoveryModeFromPreference('both')).toBe('both');
  });

  test('leaves always-ask unresolved for the UI to prompt', () => {
    expect(recoveryModeFromPreference('ask')).toBeNull();
  });
});
