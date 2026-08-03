import { describe, expect, test } from 'bun:test';
import {
  buildWebAccessRuntimeCommand,
  webAccessRuntimeCommandName,
} from './web-access-runtime';

describe('Web Access runtime actions', () => {
  test('maps each GUI action to the current plugin-owned command', () => {
    expect(webAccessRuntimeCommandName('open-curator')).toBe('websearch');
    expect(webAccessRuntimeCommandName('google-account')).toBe('google-account');
    expect(webAccessRuntimeCommandName('stored-results')).toBe('search');
  });

  test('preserves the native optional websearch argument', () => {
    expect(buildWebAccessRuntimeCommand('open-curator')).toBe('websearch');
    expect(buildWebAccessRuntimeCommand('open-curator', { query: '  pi sdk, pi extensions  ' }))
      .toBe('websearch pi sdk, pi extensions');
    expect(buildWebAccessRuntimeCommand('google-account', { query: 'ignored' }))
      .toBe('google-account');
  });
});
