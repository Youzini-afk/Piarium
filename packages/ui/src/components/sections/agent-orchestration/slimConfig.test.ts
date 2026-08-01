import { describe, expect, test } from 'bun:test';

import {
  buildSlimSavePayload,
  countFallbackChains,
  createSlimDraftFromConfig,
  getActivePreset,
  getModelString,
  hasSlimDraftChanges,
  joinModelRef,
  normalizeSlimConfig,
  parseModelRef,
} from './slimConfig';

describe('slimConfig helpers', () => {
  test('normalizes empty and invalid Slim fields out of the save payload', () => {
    expect(normalizeSlimConfig({
      preset: ' openai ',
      disabled_agents: ['observer', 'orchestrator', ''],
      autoUpdate: false,
      presets: {
        openai: {
          oracle: {
            model: ' ',
            variant: 'xhigh',
            temperature: '3',
          },
          fixer: {
            model: ' openai/gpt-5.4-mini ',
            variant: 'max',
            temperature: '0.2',
            skills: ['simplify', ''],
            mcps: [],
          },
        },
      },
    })).toEqual({
      preset: 'openai',
      disabled_agents: ['observer'],
      autoUpdate: false,
      presets: {
        openai: {
          oracle: { variant: 'xhigh' },
          fixer: {
            model: 'openai/gpt-5.4-mini',
            variant: 'max',
            temperature: 0.2,
            skills: ['simplify'],
            mcps: [],
          },
        },
      },
    });
  });

  test('creates drafts from user raw config only and leaves project overrides out of the save payload', () => {
    const draft = createSlimDraftFromConfig({
      plugin: { detected: true, enabled: true, entry: 'oh-my-opencode-slim' },
      target: { scope: 'user', path: '/tmp/slim.jsonc', exists: true, format: 'jsonc', mtimeMs: 123 },
      project: { path: '/repo/.opencode/slim.jsonc', exists: true, overriddenKeys: ['preset'] },
      raw: { preset: 'openai', presets: { openai: { fixer: { model: 'openai/gpt-5.4-mini' } } } },
      projectRaw: { preset: 'project' },
      effective: { preset: 'project' },
      presets: ['openai'],
      agents: [],
    });

    expect(buildSlimSavePayload(123, draft)).toEqual({
      expectedMtimeMs: 123,
      config: {
        preset: 'openai',
        presets: {
          openai: {
            fixer: { model: 'openai/gpt-5.4-mini' },
          },
        },
      },
    });
  });

  test('compares drafts with stable key ordering', () => {
    expect(hasSlimDraftChanges(
      { presets: { openai: { fixer: { model: 'openai/gpt-5.4-mini', temperature: 0.2 } } } },
      { presets: { openai: { fixer: { temperature: 0.2, model: 'openai/gpt-5.4-mini' } } } },
    )).toBe(false);
  });

  test('parses model refs and falls back to active preset sensibly', () => {
    expect(parseModelRef('openai/gpt-5.5')).toEqual({ providerId: 'openai', modelId: 'gpt-5.5' });
    expect(joinModelRef('openai', 'gpt-5.5')).toBe('openai/gpt-5.5');
    expect(getModelString([{ id: 'anthropic/claude', variant: 'high' }])).toBe('anthropic/claude');
    expect(getActivePreset({ presets: { openai: {} } })).toBe('openai');
  });

  test('counts fallback chains without treating project overrides as save data', () => {
    expect(countFallbackChains({
      chains: {
        oracle: ['openai/gpt-5.4-mini', '', 'anthropic/claude'],
      },
    }, 'oracle')).toBe(2);
  });
});
