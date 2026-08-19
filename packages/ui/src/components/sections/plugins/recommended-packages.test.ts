import { describe, expect, test } from 'bun:test';
import { RECOMMENDED_PACKAGES } from './recommended-packages';

describe('recommended Pi packages', () => {
  test('includes every maintained context integration with its installable source', () => {
    const sourceByName = Object.fromEntries(RECOMMENDED_PACKAGES.map((entry) => [entry.name, entry.source]));

    expect(sourceByName['pi-subagents']).toBe('npm:pi-subagents');
    expect(sourceByName['pi-background-tasks']).toBe('npm:pi-background-tasks');
    expect(RECOMMENDED_PACKAGES.find((entry) => entry.name === 'pi-background-tasks')?.workbench).toBe('fleet');
    expect(sourceByName['pi-observational-memory']).toBe('npm:pi-observational-memory');
    expect(sourceByName['context-mode']).toBe('npm:context-mode');
    expect(sourceByName['@cortexkit/aft-pi']).toBe('npm:@cortexkit/aft-pi');
    expect(sourceByName['pi-lens']).toBe('npm:pi-lens');
    expect(sourceByName['@gotgenes/pi-permission-system']).toBe('npm:@gotgenes/pi-permission-system');
    expect(sourceByName['pi-hermes-memory']).toBe('npm:pi-hermes-memory');
    expect(RECOMMENDED_PACKAGES.some((entry) => /rtk/i.test(entry.name) || /rtk/i.test(entry.source))).toBe(false);
  });

  test('does not render duplicate package identities or install sources', () => {
    const names = RECOMMENDED_PACKAGES.map((entry) => entry.name);
    const sources = RECOMMENDED_PACKAGES.map((entry) => entry.source);

    expect(new Set(names).size).toBe(names.length);
    expect(new Set(sources).size).toBe(sources.length);
  });
});
