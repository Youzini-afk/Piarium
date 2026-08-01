import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManagedOpenCodeSpawnEnv } from './opencodeManagedEnv';

describe('VS Code managed OpenCode env', () => {
  test('injects OpenChamber stream normalizer without dropping existing inline config', () => {
    const env = buildManagedOpenCodeSpawnEnv({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { test: {} }, plugin: ['existing-plugin'] }),
      CUSTOM_VALUE: 'kept',
    });
    const inlineConfig = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}');

    assert.equal(env.CUSTOM_VALUE, 'kept');
    assert.equal(env.OPENCHAMBER_OPENAI_STREAM_NORMALIZER, '1');
    assert.deepEqual(inlineConfig.provider, { test: {} });
    assert.equal(inlineConfig.plugin[0], 'existing-plugin');
    assert.match(inlineConfig.plugin[1], /openai-stream-normalizer-plugin\.mjs$/);
  });
});
