import { describe, expect, test } from 'bun:test';
import {
  isValidMagicContextSchedule,
  magicContextDraftIssue,
  magicContextProjectIgnoredPaths,
} from './magic-context-config-model';

describe('Magic Context config model', () => {
  test('matches the plugin numeric five-field cron surface', () => {
    expect(isValidMagicContextSchedule('')).toBe(true);
    expect(isValidMagicContextSchedule('0 3 * * *')).toBe(true);
    expect(isValidMagicContextSchedule('*/15 1-5/2 * * 0,7')).toBe(true);
    expect(isValidMagicContextSchedule('0 3 * *')).toBe(false);
    expect(isValidMagicContextSchedule('0 24 * * *')).toBe(false);
    expect(isValidMagicContextSchedule('0 3 * JAN *')).toBe(false);
  });

  test('reports fields that the plugin strips from project configuration', () => {
    expect(magicContextProjectIgnoredPaths({
      language: 'zh',
      embedding: { endpoint: 'https://example.test', model: 'embed' },
      historian: { model: 'provider/model', temperature: 0.2 },
      dreamer: { prompt: 'unsafe', tasks: {} },
      pi: { subagent_extensions: ['extension.ts'] },
    })).toEqual([
      'language',
      'pi.subagent_extensions',
      'embedding.endpoint',
      'historian.model',
      'dreamer.prompt',
    ]);
  });

  test('guards plugin failure cases without rejecting future unknown keys', () => {
    expect(magicContextDraftIssue({
      future_plugin_field: { enabled: true },
      dreamer: { tasks: { verify: { schedule: '0 3 * * *' } } },
    }, 'user')).toBeNull();

    expect(magicContextDraftIssue({
      dreamer: { tasks: { verify: { schedule: 'nightly' } } },
    }, 'user')).toEqual({
      code: 'invalid-schedule',
      field: 'dreamer.tasks.verify.schedule',
    });

    expect(magicContextDraftIssue({
      embedding: { provider: 'openai-compatible', model: 'embed-v1' },
    }, 'user')).toEqual({
      code: 'embedding-required',
      field: 'embedding.endpoint',
    });

    expect(magicContextDraftIssue({
      embedding: { provider: 'openai-compatible' },
      historian: { model: 42, fallback_models: [42] },
      language: 'repository-owned-value-is-ignored',
    }, 'project')).toBeNull();
  });

  test('rejects invalid values for structured fields exposed by the editor', () => {
    expect(magicContextDraftIssue({
      memory: { enabled: 'yes' },
    }, 'user')).toEqual({
      code: 'invalid-value',
      field: 'memory.enabled',
    });
    expect(magicContextDraftIssue({
      experimental: { mural: { model: '  ' } },
    }, 'project')).toEqual({
      code: 'invalid-value',
      field: 'experimental.mural.model',
    });
    expect(magicContextDraftIssue({
      system_prompt_injection: { skip_signatures: [42] },
    }, 'user')).toEqual({
      code: 'invalid-value',
      field: 'system_prompt_injection.skip_signatures',
    });
    expect(magicContextDraftIssue({
      embedding: { provider: 42 },
    }, 'user')).toEqual({
      code: 'invalid-value',
      field: 'embedding.provider',
    });
  });

  test('rejects malformed polymorphic maps while allowing valid model overrides', () => {
    expect(magicContextDraftIssue({
      cache_ttl: { default: '5m', 'provider/model': '10m' },
      execute_threshold_percentage: { default: 65, 'provider/model': 70 },
      execute_threshold_tokens: { 'provider/model': 120000 },
    }, 'user')).toBeNull();

    expect(magicContextDraftIssue({ cache_ttl: { 'provider/model': '10m' } }, 'user')).toEqual({
      code: 'invalid-value',
      field: 'cache_ttl',
    });
    expect(magicContextDraftIssue({
      execute_threshold_percentage: { default: 65, 'provider/model': 81 },
    }, 'user')).toEqual({
      code: 'invalid-value',
      field: 'execute_threshold_percentage',
    });
  });

  test('catches invalid known agent fields because the plugin drops that whole block', () => {
    expect(magicContextDraftIssue({
      dreamer: { fallback_models: [42], tasks: {} },
    }, 'user')).toEqual({
      code: 'invalid-value',
      field: 'dreamer.fallback_models',
    });
    expect(magicContextDraftIssue({
      sidekick: { permission: { bash: { 'git *': 'sometimes' } } },
    }, 'user')).toEqual({
      code: 'invalid-value',
      field: 'sidekick.permission.bash',
    });
  });
});
