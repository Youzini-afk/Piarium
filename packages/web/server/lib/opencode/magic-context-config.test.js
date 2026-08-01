import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

let tempHome;

async function loadMagicContextModule() {
  return import(/* @vite-ignore */ `./magic-context-config.js?test=${Date.now()}-${Math.random()}`);
}

function readJsoncObject(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const withoutComments = content
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return JSON.parse(withoutComments);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

describe('magic-context config helpers', () => {
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-magic-context-test-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.OPENCODE_CONFIG_DIR = path.join(tempHome, '.config', 'opencode');
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    if (originalOpenCodeConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = originalOpenCodeConfigDir;
    }
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  });

  it('resolves the default user-level CortexKit JSONC path when no config exists', async () => {
    const { readMagicContextConfig } = await loadMagicContextModule();

    const result = readMagicContextConfig();

    expect(result.target).toMatchObject({
      scope: 'user',
      path: path.join(tempHome, '.config', 'cortexkit', 'magic-context.jsonc'),
      exists: false,
      format: 'jsonc',
    });
    expect(result.source).toMatchObject({
      path: result.target.path,
      exists: false,
      format: 'jsonc',
      legacy: false,
    });
    expect(result.raw).toEqual({});
  });

  it('respects XDG_CONFIG_HOME for the CortexKit target', async () => {
    process.env.XDG_CONFIG_HOME = path.join(tempHome, 'xdg-config');
    const { readMagicContextConfig } = await loadMagicContextModule();

    const result = readMagicContextConfig();

    expect(result.target.path).toBe(path.join(tempHome, 'xdg-config', 'cortexkit', 'magic-context.jsonc'));
  });

  it('ignores a relative XDG_CONFIG_HOME and falls back to HOME/.config (matching plugin behavior)', async () => {
    process.env.XDG_CONFIG_HOME = 'relative-config';
    const { readMagicContextConfig } = await loadMagicContextModule();

    const result = readMagicContextConfig();

    expect(result.target.path).toBe(path.join(tempHome, '.config', 'cortexkit', 'magic-context.jsonc'));
  });

  it('reads legacy OpenCode user config when CortexKit target is absent, but saves to CortexKit', async () => {
    const legacyPath = path.join(process.env.OPENCODE_CONFIG_DIR, 'magic-context.jsonc');
    writeJson(legacyPath, { enabled: false, nudge_interval_tokens: 9000 });

    const { readMagicContextConfig, saveMagicContextConfig } = await loadMagicContextModule();
    const before = readMagicContextConfig();

    expect(before.raw.enabled).toBe(false);
    expect(before.source).toMatchObject({ path: legacyPath, exists: true, legacy: true });
    expect(before.target.exists).toBe(false);

    const after = saveMagicContextConfig({
      expectedMtimeMs: before.target.mtimeMs,
      sourcePath: before.source.path,
      sourceMtimeMs: before.source.mtimeMs,
      config: { ...before.raw, enabled: true },
    });

    expect(after.target.path).toBe(path.join(tempHome, '.config', 'cortexkit', 'magic-context.jsonc'));
    expect(readJsoncObject(after.target.path)).toMatchObject({ enabled: true });
    expect(readJsoncObject(after.target.path)).not.toHaveProperty('nudge_interval_tokens');
    expect(readJsoncObject(legacyPath)).toEqual({ enabled: false, nudge_interval_tokens: 9000 });
  });

  it('prefers the CortexKit target over legacy user config when both exist', async () => {
    const targetPath = path.join(tempHome, '.config', 'cortexkit', 'magic-context.jsonc');
    const legacyPath = path.join(process.env.OPENCODE_CONFIG_DIR, 'magic-context.jsonc');
    writeJson(targetPath, { enabled: true });
    writeJson(legacyPath, { enabled: false });

    const { readMagicContextConfig } = await loadMagicContextModule();
    const result = readMagicContextConfig();

    expect(result.raw.enabled).toBe(true);
    expect(result.source).toMatchObject({ path: targetPath, legacy: false });
  });

  it('detects project .cortexkit config before project legacy fallbacks and reports legacy project sources', async () => {
    const projectDir = path.join(tempHome, 'project');
    const cortexProjectPath = path.join(projectDir, '.cortexkit', 'magic-context.jsonc');
    const rootLegacyPath = path.join(projectDir, 'magic-context.jsonc');
    const dotOpenCodeLegacyPath = path.join(projectDir, '.opencode', 'magic-context.jsonc');
    writeJson(cortexProjectPath, { memory: { enabled: true } });
    writeJson(rootLegacyPath, { enabled: false });
    writeJson(dotOpenCodeLegacyPath, { historian: { model: 'openai/gpt-5.5' } });

    const { readMagicContextConfig } = await loadMagicContextModule();
    const current = readMagicContextConfig({ directory: projectDir });

    expect(current.project).toMatchObject({
      path: cortexProjectPath,
      exists: true,
      overriddenKeys: ['memory'],
      legacy: false,
      source: { path: cortexProjectPath, legacy: false },
    });

    fs.rmSync(cortexProjectPath);
    const legacy = readMagicContextConfig({ directory: projectDir });

    expect(legacy.project).toMatchObject({
      path: rootLegacyPath,
      exists: true,
      overriddenKeys: ['enabled'],
      legacy: true,
      source: { path: rootLegacyPath, legacy: true },
    });
  });

  it('blocks save when a legacy read source changed before CortexKit target exists', async () => {
    const legacyPath = path.join(process.env.OPENCODE_CONFIG_DIR, 'magic-context.jsonc');
    writeJson(legacyPath, { enabled: false });

    const { readMagicContextConfig, saveMagicContextConfig } = await loadMagicContextModule();
    const before = readMagicContextConfig();
    writeJson(legacyPath, { enabled: true });
    fs.utimesSync(legacyPath, new Date(before.source.mtimeMs + 10_000), new Date(before.source.mtimeMs + 10_000));

    expect(() => saveMagicContextConfig({
      expectedMtimeMs: before.target.mtimeMs,
      sourcePath: before.source.path,
      sourceMtimeMs: before.source.mtimeMs,
      config: { enabled: true },
    })).toThrow(/modified outside OpenChamber/);
    expect(fs.existsSync(path.join(tempHome, '.config', 'cortexkit', 'magic-context.jsonc'))).toBe(false);
  });

  it('blocks save when CortexKit target is created concurrently after a legacy fallback load', async () => {
    const legacyPath = path.join(process.env.OPENCODE_CONFIG_DIR, 'magic-context.jsonc');
    writeJson(legacyPath, { enabled: false });

    const { readMagicContextConfig, saveMagicContextConfig } = await loadMagicContextModule();
    const before = readMagicContextConfig();
    expect(before.target.exists).toBe(false);
    expect(before.target.mtimeMs).toBeNull();

    const targetPath = path.join(tempHome, '.config', 'cortexkit', 'magic-context.jsonc');
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, [
      '{',
      '  // created by another process',
      '  "enabled": true,',
      '  "future_field": { "keep": true }',
      '}',
      '',
    ].join('\n'));

    expect(() => saveMagicContextConfig({
      expectedMtimeMs: before.target.mtimeMs,
      sourcePath: before.source.path,
      sourceMtimeMs: before.source.mtimeMs,
      config: { ...before.raw, enabled: true },
    })).toThrow(/modified outside OpenChamber/);

    const parsed = readJsoncObject(targetPath);
    expect(parsed).toEqual({ enabled: true, future_field: { keep: true } });
    expect(fs.readFileSync(targetPath, 'utf8')).toContain('// created by another process');
    expect(readJsoncObject(legacyPath)).toEqual({ enabled: false });
  });

  it('seeds the new CortexKit target with legacy file content (incl. comments) on first save', async () => {
    const legacyPath = path.join(process.env.OPENCODE_CONFIG_DIR, 'magic-context.jsonc');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, [
      '{',
      '  // legacy header comment',
      '  "enabled": false,',
      '  "nudge_interval_tokens": 9000,',
      '  "dreamer": {',
      '    "enabled": false,',
      '    "schedule": "02:00-06:00",',
      '    "tasks": ["verify"]',
      '  }',
      '}',
      '',
    ].join('\n'));

    const { readMagicContextConfig, saveMagicContextConfig } = await loadMagicContextModule();
    const before = readMagicContextConfig();
    expect(before.target.exists).toBe(false);
    expect(before.source.path).toBe(legacyPath);

    const after = saveMagicContextConfig({
      expectedMtimeMs: before.target.mtimeMs,
      sourcePath: before.source.path,
      sourceMtimeMs: before.source.mtimeMs,
      config: { ...before.raw, enabled: true },
    });

    const targetPath = path.join(tempHome, '.config', 'cortexkit', 'magic-context.jsonc');
    expect(after.target.path).toBe(targetPath);
    const content = fs.readFileSync(targetPath, 'utf8');
    expect(content).toContain('// legacy header comment');
    const parsed = readJsoncObject(targetPath);
    expect(parsed.enabled).toBe(true);
    expect(parsed).not.toHaveProperty('nudge_interval_tokens');
    expect(parsed.dreamer.disable).toBe(true);
    expect(parsed.dreamer.tasks.verify.schedule).toBe('0 2 * * *');
    expect(parsed.dreamer.tasks['verify-broad'].schedule).toBe('0 4 * * 0');
    expect(parsed.dreamer).not.toHaveProperty('enabled');
    expect(parsed.dreamer).not.toHaveProperty('schedule');
    expect(parsed.$schema).toBe('https://raw.githubusercontent.com/cortexkit/magic-context/master/assets/magic-context.schema.json');

    // Legacy file is untouched.
    const legacyContent = fs.readFileSync(legacyPath, 'utf8');
    expect(readJsoncObject(legacyPath)).toEqual({
      enabled: false,
      nudge_interval_tokens: 9000,
      dreamer: { enabled: false, schedule: '02:00-06:00', tasks: ['verify'] },
    });
    expect(legacyContent).toContain('// legacy header comment');
  });

  it('returns config with directory context after save so project diagnostics persist', async () => {
    const projectDir = path.join(tempHome, 'project');
    writeJson(path.join(projectDir, '.cortexkit', 'magic-context.jsonc'), { auto_update: false });

    const { saveMagicContextConfig } = await loadMagicContextModule();
    const result = saveMagicContextConfig({
      directory: projectDir,
      expectedMtimeMs: null,
      config: { enabled: true },
    });

    expect(result.project.exists).toBe(true);
    expect(result.diagnostics.project.ignoredUserOnlyKeys).toEqual(['auto_update']);
  });

  it('preserves comments and unrelated future fields in existing targets while saving current schema fields', async () => {
    const targetPath = path.join(tempHome, '.config', 'cortexkit', 'magic-context.jsonc');
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, [
      '{',
      '  // keep this comment',
      '  "future_field": { "keep": true },',
      '  "enabled": false',
      '}',
      '',
    ].join('\n'));

    const { readMagicContextConfig, saveMagicContextConfig } = await loadMagicContextModule();
    const before = readMagicContextConfig();
    saveMagicContextConfig({
      expectedMtimeMs: before.target.mtimeMs,
      config: {
        enabled: true,
        embedding: { input_type: 'search_document', query_input_type: 'search_query', truncate: 'END', max_input_tokens: '8192' },
        memory: {
          auto_search: { enabled: true, score_threshold: '0.8', min_prompt_chars: '25' },
          git_commit_indexing: { enabled: true, since_days: '30', max_commits: '500' },
        },
        historian: { disallowed_tools: ['read', 'bad', 'aft_search'] },
        command: { hello: { template: 'echo hello' } },
        disabled_hooks: ['hook-a', 'hook-a', 'hook-b'],
        unknown_future: { keep: true },
      },
    });

    const content = fs.readFileSync(targetPath, 'utf8');
    const parsed = readJsoncObject(targetPath);
    expect(content).toContain('// keep this comment');
    expect(parsed.future_field).toEqual({ keep: true });
    expect(parsed.enabled).toBe(true);
    expect(parsed.embedding).toMatchObject({ input_type: 'search_document', query_input_type: 'search_query', truncate: 'END', max_input_tokens: 8192 });
    expect(parsed.memory.auto_search).toEqual({ enabled: true, score_threshold: 0.8, min_prompt_chars: 25 });
    expect(parsed.memory.git_commit_indexing).toEqual({ enabled: true, since_days: 30, max_commits: 500 });
    expect(parsed.historian.disallowed_tools).toEqual(['read', 'aft_search']);
    expect(parsed.command).toEqual({ hello: { template: 'echo hello' } });
    expect(parsed.disabled_hooks).toEqual(['hook-a', 'hook-b']);
    expect(parsed.unknown_future).toEqual({ keep: true });
  });

  it('removes retired top-level keys from existing CortexKit targets while preserving comments and unknown fields', async () => {
    const targetPath = path.join(tempHome, '.config', 'cortexkit', 'magic-context.jsonc');
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, [
      '{',
      '  // keep this comment',
      '  "enabled": false,',
      '  "toast_duration_ms": 5000,',
      '  "unknown_future": { "keep": true },',
      '  "nudge_interval_tokens": 1000,',
      '  "auto_drop_tool_age": 100,',
      '  "drop_tool_structure": true,',
      '  "iteration_nudge_threshold": 10,',
      '  "compaction_markers": true,',
      '  "compressor": { "enabled": true },',
      '  "experimental": { "temporal_awareness": true }',
      '}',
      '',
    ].join('\n'));

    const { readMagicContextConfig, saveMagicContextConfig } = await loadMagicContextModule();
    const before = readMagicContextConfig();
    saveMagicContextConfig({
      expectedMtimeMs: before.target.mtimeMs,
      config: { ...before.raw, enabled: true },
    });

    const content = fs.readFileSync(targetPath, 'utf8');
    const parsed = readJsoncObject(targetPath);
    expect(content).toContain('// keep this comment');
    for (const key of ['nudge_interval_tokens', 'auto_drop_tool_age', 'drop_tool_structure', 'iteration_nudge_threshold', 'compaction_markers', 'compressor', 'experimental']) {
      expect(parsed).not.toHaveProperty(key);
    }
    expect(parsed.enabled).toBe(true);
    expect(parsed.toast_duration_ms).toBe(5000);
    expect(parsed.unknown_future).toEqual({ keep: true });
    expect(parsed.temporal_awareness).toBe(true);
  });

  it('sanitizes current schema, migrates retired experimental fields, and drops retired top-level keys', async () => {
    const { sanitizeMagicContextConfig } = await loadMagicContextModule();

    const result = sanitizeMagicContextConfig({
      enabled: true,
      nudge_interval_tokens: 1000,
      auto_drop_tool_age: 100,
      drop_tool_structure: true,
      iteration_nudge_threshold: 10,
      compaction_markers: true,
      compressor: { enabled: true },
      experimental: {
        temporal_awareness: true,
        caveman_text_compression: { enabled: true, min_chars: '500' },
        auto_search: { enabled: true, score_threshold: '0.75', min_prompt_chars: '20' },
        git_commit_indexing: { enabled: true, since_days: '60', max_commits: '1000' },
      },
      toast_duration_ms: '5000',
      keep_subagents: true,
      sqlite: { cache_size_mb: '256', mmap_size_mb: '1024' },
      embedding: { input_type: 'search_document', query_input_type: 'search_query', truncate: 'END', max_input_tokens: '4096' },
      memory: { enabled: true },
      historian: { enabled: false, disallowed_tools: ['*', 'bad', 'aft_zoom'] },
      dreamer: { enabled: false, schedule: '03:15-06:00', tasks: ['verify'], task_timeout_minutes: 25, user_memories: { enabled: true, promotion_threshold: 6 } },
      sidekick: { enabled: false },
      command: { hello: { template: 'echo hello' } },
      disabled_hooks: ['a', 'a', 'b'],
      unknown_future: { keep: true },
    });

    for (const key of ['nudge_interval_tokens', 'auto_drop_tool_age', 'drop_tool_structure', 'iteration_nudge_threshold', 'compaction_markers', 'compressor', 'experimental']) {
      expect(result).not.toHaveProperty(key);
    }
    expect(result).toMatchObject({
      enabled: true,
      toast_duration_ms: 5000,
      temporal_awareness: true,
      keep_subagents: true,
      sqlite: { cache_size_mb: 256, mmap_size_mb: 1024 },
      caveman_text_compression: { enabled: true, min_chars: 500 },
      embedding: { input_type: 'search_document', query_input_type: 'search_query', truncate: 'END', max_input_tokens: 4096 },
      memory: {
        enabled: true,
        auto_search: { enabled: true, score_threshold: 0.75, min_prompt_chars: 20 },
        git_commit_indexing: { enabled: true, since_days: 60, max_commits: 1000 },
      },
      historian: { disallowed_tools: ['*', 'aft_zoom'] },
      dreamer: {
        disable: true,
        tasks: {
          verify: { schedule: '15 3 * * *', timeout_minutes: 25 },
          'verify-broad': { schedule: '0 4 * * 0', timeout_minutes: 25 },
          curate: { schedule: '', timeout_minutes: 25 },
          'review-user-memories': { schedule: '15 3 * * *', promotion_threshold: 6, timeout_minutes: 25 },
        },
      },
      sidekick: { disable: true },
      command: { hello: { template: 'echo hello' } },
      disabled_hooks: ['a', 'b'],
      unknown_future: { keep: true },
    });
    expect(result.historian).not.toHaveProperty('enabled');
    expect(result.dreamer).not.toHaveProperty('enabled');
    expect(result.sidekick).not.toHaveProperty('enabled');
  });

  it('migrates legacy experimental.user_memories (boolean false) into v2 review-user-memories opt-out', async () => {
    const { sanitizeMagicContextConfig } = await loadMagicContextModule();

    const result = sanitizeMagicContextConfig({
      experimental: { user_memories: false },
      dreamer: { tasks: { verify: { schedule: '0 2 * * *' } } },
    });

    expect(result).not.toHaveProperty('experimental');
    expect(result.dreamer).not.toHaveProperty('user_memories');
    expect(result.dreamer.tasks['review-user-memories'].schedule).toBe('');
  });

  it('migrates legacy experimental.user_memories object into v2 review-user-memories with promotion_threshold', async () => {
    const { sanitizeMagicContextConfig } = await loadMagicContextModule();

    const result = sanitizeMagicContextConfig({
      experimental: { user_memories: { enabled: true, promotion_threshold: 6 } },
      dreamer: { schedule: '02:00-06:00' },
    });

    expect(result).not.toHaveProperty('experimental');
    expect(result.dreamer).not.toHaveProperty('user_memories');
    expect(result.dreamer.tasks['review-user-memories'].schedule).toBe('0 2 * * *');
    expect(result.dreamer.tasks['review-user-memories'].promotion_threshold).toBe(6);
  });

  it('merges experimental.user_memories into an existing dreamer.user_memories (destination wins, source sub-fields preserved)', async () => {
    const { sanitizeMagicContextConfig } = await loadMagicContextModule();

    const result = sanitizeMagicContextConfig({
      experimental: { user_memories: { enabled: true, promotion_threshold: 6 } },
      dreamer: {
        user_memories: { promotion_threshold: 9 },
        schedule: '02:00-06:00',
      },
    });

    expect(result).not.toHaveProperty('experimental');
    expect(result.dreamer).not.toHaveProperty('user_memories');
    // destination promotion_threshold (9) wins over experimental (6)
    expect(result.dreamer.tasks['review-user-memories'].promotion_threshold).toBe(9);
    expect(result.dreamer.tasks['review-user-memories'].schedule).toBe('0 2 * * *');
  });

  it('migrates legacy experimental.pin_key_files without producing stale pin_key_files or key-files task', async () => {
    const { sanitizeMagicContextConfig } = await loadMagicContextModule();

    const result = sanitizeMagicContextConfig({
      experimental: { pin_key_files: { enabled: true, token_budget: 12000 } },
      dreamer: { schedule: '02:00-06:00', tasks: ['verify'] },
    });

    expect(result).not.toHaveProperty('experimental');
    expect(result.dreamer).not.toHaveProperty('pin_key_files');
    expect(result.dreamer.tasks).not.toHaveProperty('key-files');
    // Other v2 migration still proceeds (verify/curate/verify-broad/review-user-memories).
    expect(result.dreamer.tasks.verify.schedule).toBe('0 2 * * *');
    expect(result.dreamer.tasks.curate.schedule).toBe('');
    expect(result.dreamer.tasks['verify-broad'].schedule).toBe('0 4 * * 0');
    expect(result.dreamer.tasks['review-user-memories'].schedule).toBe('0 2 * * *');
  });

  it('detects the Youzini Magic Context fork package as a valid plugin entry', async () => {
    const userConfigDir = process.env.OPENCODE_CONFIG_DIR;
    writeJson(path.join(userConfigDir, 'opencode.jsonc'), {
      plugin: ['@youzini/opencode-magic-context@0.18.0-youzini.0'],
    });
    writeJson(path.join(userConfigDir, 'tui.jsonc'), {
      plugin: ['@youzini/opencode-magic-context'],
    });

    const { readMagicContextConfig } = await loadMagicContextModule();
    const result = readMagicContextConfig();

    expect(result.plugin).toMatchObject({
      detected: true,
      entry: '@youzini/opencode-magic-context@0.18.0-youzini.0',
      configPath: path.join(userConfigDir, 'opencode.jsonc'),
    });
    expect(result.diagnostics.tui).toMatchObject({
      detected: true,
      entry: '@youzini/opencode-magic-context',
      configPath: path.join(userConfigDir, 'tui.jsonc'),
    });
  });
});
