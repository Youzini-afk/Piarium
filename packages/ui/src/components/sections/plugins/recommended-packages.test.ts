import { describe, expect, test } from 'bun:test';
import { RECOMMENDED_PACKAGES } from './recommended-packages';

describe('recommended Pi packages', () => {
  test('includes every maintained context integration with its installable source', () => {
    const sourceByName = Object.fromEntries(RECOMMENDED_PACKAGES.map((entry) => [entry.name, entry.source]));

    expect(sourceByName['pi-openai-codex-compat']).toBe('npm:pi-openai-codex-compat@alpha');
    expect(sourceByName['pi-observational-memory']).toBe('npm:pi-observational-memory');
    expect(sourceByName['context-mode']).toBe('npm:context-mode');
    expect(sourceByName['@cortexkit/aft-pi']).toBe('npm:@cortexkit/aft-pi');
    expect(sourceByName['pi-lens']).toBe('npm:pi-lens');
    expect(sourceByName['@gotgenes/pi-permission-system']).toBe('npm:@gotgenes/pi-permission-system');
  });

  test('does not render duplicate package identities or install sources', () => {
    const names = RECOMMENDED_PACKAGES.map((entry) => entry.name);
    const sources = RECOMMENDED_PACKAGES.map((entry) => entry.source);

    expect(new Set(names).size).toBe(names.length);
    expect(new Set(sources).size).toBe(sources.length);
  });
});
