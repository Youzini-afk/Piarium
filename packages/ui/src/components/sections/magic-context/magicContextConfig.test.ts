import { describe, expect, test } from 'bun:test';

import {
  agentFallbackModelsToRows,
  agentFallbackRowsToConfig,
  buildMagicContextSavePayload,
  createMagicContextDraftFromConfig,
  hasMagicContextDraftChanges,
  normalizeMagicContextConfig,
  type MagicContextConfig,
} from './magicContextConfig';

describe('magicContextConfig helpers', () => {
  test('drops retired fields but preserves unknown future top-level fields', () => {
    expect(normalizeMagicContextConfig({
      enabled: true,
      nudge_interval_tokens: 1000,
      auto_drop_tool_age: 100,
      drop_tool_structure: true,
      iteration_nudge_threshold: 10,
      compaction_markers: true,
      compressor: { enabled: true },
      future_top_level: { keep: true },
      historian: { model: ' ', maxTokens: '', fallback_models: [], temperature: '3' },
    })).toEqual({
      enabled: true,
      future_top_level: { keep: true },
    });
  });

  test('preserves per-model scalar maps', () => {
    expect(normalizeMagicContextConfig({
      cache_ttl: {
        default: '5m',
        'anthropic/claude-opus-4-6': '60m',
        empty: '',
      },
      execute_threshold_percentage: {
        default: 65,
        'github-copilot/gpt-5.2-codex': '40',
        bad: 90,
      },
      execute_threshold_tokens: {
        default: '150000',
        bad: 20,
      },
    })).toEqual({
      cache_ttl: {
        default: '5m',
        'anthropic/claude-opus-4-6': '60m',
      },
      execute_threshold_percentage: {
        default: 65,
        'github-copilot/gpt-5.2-codex': 40,
      },
      execute_threshold_tokens: {
        default: 150000,
      },
    });
  });

  test('canonicalizes legacy schema url during save normalization', () => {
    expect(normalizeMagicContextConfig({
      $schema: 'https://raw.githubusercontent.com/cortexkit/opencode-magic-context/master/assets/magic-context.schema.json',
    }).$schema).toBe('https://raw.githubusercontent.com/cortexkit/magic-context/master/assets/magic-context.schema.json');
  });

  test('converts legacy fallback objects to Magic Context string fallback models', () => {
    const rows = agentFallbackModelsToRows([
      'openai/gpt-5.4',
      {
        model: 'anthropic/claude-opus-4-6',
        variant: 'max',
        maxTokens: 4096,
      },
    ]);

    expect(agentFallbackRowsToConfig(rows)).toEqual([
      'openai/gpt-5.4',
      'anthropic/claude-opus-4-6',
    ]);
  });

  test('migrates legacy experimental namespace to stable fields', () => {
    expect(normalizeMagicContextConfig({
      experimental: {
        temporal_awareness: true,
        future_experimental: { drop: true },
        caveman_text_compression: { enabled: true, min_chars: '500' },
        git_commit_indexing: { enabled: true, since_days: '30', legacy: 'keep' },
        auto_search: { enabled: true, score_threshold: '0.7', min_prompt_chars: '25' },
      },
    })).toEqual({
      temporal_awareness: true,
      caveman_text_compression: { enabled: true, min_chars: 500 },
      memory: {
        git_commit_indexing: { legacy: 'keep', enabled: true, since_days: 30 },
        auto_search: { enabled: true, score_threshold: 0.7, min_prompt_chars: 25 },
      },
    });
  });

  test('migrates legacy experimental.user_memories boolean false into v2 review-user-memories opt-out', () => {
    const normalized = normalizeMagicContextConfig({
      experimental: { user_memories: false },
      dreamer: { schedule: '02:00-06:00' },
    });
    expect(Object.prototype.hasOwnProperty.call(normalized, 'experimental')).toBe(false);
    expect(normalized.dreamer && Object.prototype.hasOwnProperty.call(normalized.dreamer, 'user_memories')).toBe(false);
    expect(normalized.dreamer?.tasks?.['review-user-memories']?.schedule).toBe('');
  });

  test('migrates legacy experimental.user_memories object into v2 review-user-memories with promotion_threshold', () => {
    const normalized = normalizeMagicContextConfig({
      experimental: { user_memories: { enabled: true, promotion_threshold: 6 } },
      dreamer: { schedule: '02:00-06:00' },
    });
    expect(Object.prototype.hasOwnProperty.call(normalized, 'experimental')).toBe(false);
    expect(normalized.dreamer && Object.prototype.hasOwnProperty.call(normalized.dreamer, 'user_memories')).toBe(false);
    expect(normalized.dreamer?.tasks?.['review-user-memories']?.schedule).toBe('0 2 * * *');
    expect(normalized.dreamer?.tasks?.['review-user-memories']?.promotion_threshold).toBe(6);
  });

  test('merges experimental.user_memories into existing dreamer.user_memories (destination wins, source sub-fields preserved)', () => {
    const normalized = normalizeMagicContextConfig({
      experimental: { user_memories: { enabled: true, promotion_threshold: 6 } },
      dreamer: {
        user_memories: { promotion_threshold: 9 },
        schedule: '02:00-06:00',
      },
    });
    expect(Object.prototype.hasOwnProperty.call(normalized, 'experimental')).toBe(false);
    expect(normalized.dreamer && Object.prototype.hasOwnProperty.call(normalized.dreamer, 'user_memories')).toBe(false);
    // destination promotion_threshold (9) wins over experimental (6)
    expect(normalized.dreamer?.tasks?.['review-user-memories']?.promotion_threshold).toBe(9);
    expect(normalized.dreamer?.tasks?.['review-user-memories']?.schedule).toBe('0 2 * * *');
  });

  test('migrates legacy experimental.pin_key_files without stale pin_key_files or key-files task', () => {
    const normalized = normalizeMagicContextConfig({
      experimental: { pin_key_files: { enabled: true, token_budget: 12000 } },
      dreamer: { schedule: '02:00-06:00', tasks: ['verify'] },
    });
    expect(Object.prototype.hasOwnProperty.call(normalized, 'experimental')).toBe(false);
    expect(normalized.dreamer && Object.prototype.hasOwnProperty.call(normalized.dreamer, 'pin_key_files')).toBe(false);
    expect(normalized.dreamer?.tasks && Object.prototype.hasOwnProperty.call(normalized.dreamer.tasks, 'key-files')).toBe(false);
    // Other v2 migration still proceeds.
    expect(normalized.dreamer?.tasks?.verify?.schedule).toBe('0 2 * * *');
    expect(normalized.dreamer?.tasks?.curate?.schedule).toBe('');
    expect(normalized.dreamer?.tasks?.['verify-broad']?.schedule).toBe('0 4 * * 0');
    expect(normalized.dreamer?.tasks?.['review-user-memories']?.schedule).toBe('0 2 * * *');
  });

  test('createMagicContextDraftFromConfig migrates legacy experimental.user_memories into v2 tasks and drops retired experimental', () => {
    const raw = {
      experimental: { user_memories: { enabled: true, promotion_threshold: 6 } },
      dreamer: { schedule: '02:00-06:00' },
    } as unknown as MagicContextConfig;
    const draft = createMagicContextDraftFromConfig({ raw });
    expect(Object.prototype.hasOwnProperty.call(draft, 'experimental')).toBe(false);
    expect(draft.dreamer && Object.prototype.hasOwnProperty.call(draft.dreamer, 'user_memories')).toBe(false);
    expect(draft.dreamer?.tasks?.['review-user-memories']?.schedule).toBe('0 2 * * *');
    expect(draft.dreamer?.tasks?.['review-user-memories']?.promotion_threshold).toBe(6);
  });

  test('migrates Dreamer v1 array/window/user_memories/task_timeout to v2 tasks object', () => {
    const normalized = normalizeMagicContextConfig({
      dreamer: {
        enabled: false,
        schedule: '02:30-06:00',
        tasks: ['verify'],
        task_timeout_minutes: 25,
        user_memories: { enabled: true, promotion_threshold: 6 },
        pin_key_files: { enabled: true, token_budget: 12000 },
      },
    });
    expect(normalized.dreamer?.disable).toBe(true);
    expect(normalized.dreamer?.tasks?.verify).toEqual({ schedule: '30 2 * * *', timeout_minutes: 25 });
    expect(normalized.dreamer?.tasks?.['verify-broad']).toEqual({ schedule: '0 4 * * 0', timeout_minutes: 25 });
    expect(normalized.dreamer?.tasks?.curate).toEqual({ schedule: '', timeout_minutes: 25 });
    expect(normalized.dreamer?.tasks?.['review-user-memories']).toEqual({ schedule: '30 2 * * *', promotion_threshold: 6, timeout_minutes: 25 });
    const dreamer = normalizeMagicContextConfig({ dreamer: { schedule: '02:30-06:00', tasks: ['verify'], pin_key_files: { enabled: true } } }).dreamer ?? {};
    expect('enabled' in dreamer).toBe(false);
    expect('schedule' in dreamer).toBe(false);
    expect('task_timeout_minutes' in dreamer).toBe(false);
    expect('user_memories' in dreamer).toBe(false);
    expect('pin_key_files' in dreamer).toBe(false);
  });

  test('keeps already-v2 Dreamer tasks stable and preserves custom cron/model/fallback', () => {
    expect(normalizeMagicContextConfig({
      dreamer: {
        model: 'openai/gpt-5.5',
        tasks: {
          verify: {
            schedule: '',
            model: 'anthropic/claude-sonnet-4-6',
            fallback_models: [{ model: 'openai/gpt-5.4' }],
            broad_interval_days: 14,
            custom_future: true,
          },
          curate: { schedule: '0 1 * * *' },
        },
      },
    })).toEqual({
      dreamer: {
        model: 'openai/gpt-5.5',
        tasks: {
          verify: {
            schedule: '',
            model: 'anthropic/claude-sonnet-4-6',
            fallback_models: ['openai/gpt-5.4'],
            custom_future: true,
          },
          curate: { schedule: '0 1 * * *' },
          'verify-broad': { schedule: '' },
        },
      },
    });
  });

  test('migrates enabled false to disable true for dreamer/sidekick and drops historian enabled', () => {
    expect(normalizeMagicContextConfig({
      dreamer: { enabled: false },
      sidekick: { enabled: false, timeout_ms: '30000' },
      historian: { enabled: false, model: 'openai/gpt-5.5' },
    })).toEqual({
      dreamer: { disable: true },
      sidekick: { disable: true, timeout_ms: 30000 },
      historian: { model: 'openai/gpt-5.5' },
    });
  });

  test('createMagicContextDraftFromConfig initializes from migrated/normalized effective config (legacy -> v2)', () => {
    // The server may return legacy raw config (e.g. dreamer.tasks as an array)
    // which the v2 MagicContextConfig type does not represent; cast through
    // unknown to feed the legacy shape to the draft builder.
    const raw = {
      dreamer: {
        enabled: false,
        schedule: '02:00-06:00',
        tasks: ['verify'],
      },
      sidekick: { enabled: false, timeout_ms: '30000' },
      historian: { enabled: false, model: 'openai/gpt-5.5' },
      unknown_future: { keep: true },
    } as unknown as MagicContextConfig;
    const draft = createMagicContextDraftFromConfig({ raw });

    // Legacy dreamer.enabled=false migrates to disable=true; legacy
    // schedule/tasks array migrate to v2 tasks object with verify-broad
    // enabled weekly.
    expect(draft.dreamer?.disable).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(draft.dreamer ?? {}, 'enabled')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(draft.dreamer ?? {}, 'schedule')).toBe(false);
    expect(draft.dreamer?.tasks?.verify?.schedule).toBe('0 2 * * *');
    expect(draft.dreamer?.tasks?.['verify-broad']?.schedule).toBe('0 4 * * 0');

    // Legacy sidekick.enabled=false migrates to disable=true.
    expect(draft.sidekick?.disable).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(draft.sidekick ?? {}, 'enabled')).toBe(false);
    expect(draft.sidekick?.timeout_ms).toBe(30000);

    // Legacy historian.enabled is dropped (historian has no disable field).
    expect(Object.prototype.hasOwnProperty.call(draft.historian ?? {}, 'enabled')).toBe(false);
    expect(draft.historian?.model).toBe('openai/gpt-5.5');

    // Unknown future fields survive normalization for comment-safe save.
    expect(draft.unknown_future).toEqual({ keep: true });
  });

  test('includes new embedding, memory, historian, command, hooks, and unknown fields in save payload', () => {
    const draft = createMagicContextDraftFromConfig({
      raw: {
        embedding: { input_type: 'search_document', query_input_type: 'search_query', truncate: 'END', max_input_tokens: '4096' },
        memory: {
          auto_search: { enabled: true, score_threshold: '0.8', min_prompt_chars: '50' },
          git_commit_indexing: { enabled: true, since_days: '90', max_commits: '1500' },
        },
        historian: { disallowed_tools: ['read', 'bad', 'aft_search'] },
        sqlite: { cache_size_mb: '128', mmap_size_mb: '512' },
        caveman_text_compression: { enabled: true, min_chars: '600' },
        command: { hello: { template: 'echo hello' } },
        disabled_hooks: ['a', 'a', 'b'],
        unknown_future: { keep: true },
      },
    });

    expect(buildMagicContextSavePayload(123, draft, { path: '/legacy', mtimeMs: 456 })).toEqual({
      expectedMtimeMs: 123,
      sourcePath: '/legacy',
      sourceMtimeMs: 456,
      config: {
        embedding: { input_type: 'search_document', query_input_type: 'search_query', truncate: 'END', max_input_tokens: 4096 },
        memory: {
          auto_search: { enabled: true, score_threshold: 0.8, min_prompt_chars: 50 },
          git_commit_indexing: { enabled: true, since_days: 90, max_commits: 1500 },
        },
        historian: { disallowed_tools: ['read', 'aft_search'] },
        sqlite: { cache_size_mb: 128, mmap_size_mb: 512 },
        caveman_text_compression: { enabled: true, min_chars: 600 },
        command: { hello: { template: 'echo hello' } },
        disabled_hooks: ['a', 'b'],
        unknown_future: { keep: true },
      },
    });
  });

  test('keeps top-level deletion markers in the save payload for current fields only', () => {
    expect(buildMagicContextSavePayload(123, {
      enabled: true,
      execute_threshold_percentage: '',
      nudge_interval_tokens: 1000,
      historian: {
        model: '',
        fallback_models: [],
      },
    })).toEqual({
      expectedMtimeMs: 123,
      sourcePath: null,
      sourceMtimeMs: null,
      config: {
        enabled: true,
        execute_threshold_percentage: '',
        historian: {
          model: '',
          fallback_models: [],
        },
      },
    });
  });

  test('compares drafts with stable key ordering', () => {
    expect(hasMagicContextDraftChanges(
      { historian: { model: 'openai/gpt-5.4', temperature: 1 } },
      { historian: { temperature: 1, model: 'openai/gpt-5.4' } },
    )).toBe(false);
  });
});
