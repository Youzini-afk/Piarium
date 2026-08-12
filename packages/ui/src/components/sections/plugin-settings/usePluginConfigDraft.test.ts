import { describe, expect, test } from 'bun:test';
import {
  parsePluginTextObjectDraft,
  shouldApplyPluginDraftReload,
} from './usePluginConfigDraft';

describe('plugin text draft recovery', () => {
  test('keeps an invalid JSONC document repairable instead of treating it as a load failure', () => {
    const result = parsePluginTextObjectDraft('{\n  // keep me\n  "enabled": true,,\n}\n', 'jsonc');

    expect(result.draft).toEqual({});
    expect(result.rawError).toContain('at offset');
  });

  test('returns the repaired object after the raw editor becomes valid', () => {
    const result = parsePluginTextObjectDraft('{\n  // keep me\n  "enabled": true,\n}\n', 'jsonc');

    expect(result).toEqual({ draft: { enabled: true }, rawError: null });
  });
});

describe('plugin draft refresh reconciliation', () => {
  test('does not apply an automatic reload after the draft changes in flight', () => {
    expect(shouldApplyPluginDraftReload({ preserveNewerDraft: true }, 3, 4)).toBe(false);
    expect(shouldApplyPluginDraftReload({ preserveNewerDraft: true }, 3, 3)).toBe(true);
  });

  test('explicit reload still replaces the draft', () => {
    expect(shouldApplyPluginDraftReload({}, 3, 4)).toBe(true);
  });
});
