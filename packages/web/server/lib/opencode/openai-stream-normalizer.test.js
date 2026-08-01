import { describe, expect, it } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  appendOpenAIStreamNormalizerPlugin,
  createOpenAIStreamNormalizeTransform,
  ensureOpenAIStreamNormalizerPluginFile,
  normalizeOpenAIStreamLine,
  withOpenAIStreamNormalizerEnv,
} from './openai-stream-normalizer.js';

async function runTransform(inputChunks) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of inputChunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  }).pipeThrough(createOpenAIStreamNormalizeTransform());

  const reader = stream.getReader();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode();
  return result;
}

async function runByteTransform(inputChunks) {
  const decoder = new TextDecoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of inputChunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  }).pipeThrough(createOpenAIStreamNormalizeTransform());

  const reader = stream.getReader();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode();
  return result;
}

describe('OpenAI stream normalizer', () => {
  it('injects empty choices for usage-only chat completion chunks', () => {
    const line = 'data: {"object":"chat.completion.chunk","usage":{"total_tokens":1}}';

    expect(normalizeOpenAIStreamLine(line)).toBe(
      'data: {"object":"chat.completion.chunk","usage":{"total_tokens":1},"choices":[]}'
    );
  });

  it('leaves normal chunks, done sentinels, comments, and unrelated JSON unchanged', () => {
    const lines = [
      'data: [DONE]',
      ': heartbeat',
      'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"x"}}]}',
      'data: {"object":"other","usage":{"total_tokens":1}}',
      'data: not-json',
    ];

    expect(lines.map(normalizeOpenAIStreamLine)).toEqual(lines);
  });

  it('normalizes split SSE lines without buffering the whole response', async () => {
    const output = await runTransform([
      'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"你"}}]}\n',
      'data: {"object":"chat.completion.chunk",',
      '"usage":{"total_tokens":2}}\n',
      'data: [DONE]\n',
    ]);

    expect(output).toBe([
      'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"你"}}]}',
      'data: {"object":"chat.completion.chunk","usage":{"total_tokens":2},"choices":[]}',
      'data: [DONE]',
      '',
    ].join('\n'));
  });

  it('keeps UTF-8 characters intact when byte chunks split a multibyte sequence', async () => {
    const bytes = new TextEncoder().encode(
      'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"你"}}]}\n'
      + 'data: {"object":"chat.completion.chunk","usage":{"total_tokens":2}}\n'
    );

    const output = await runByteTransform([
      bytes.slice(0, 74),
      bytes.slice(74, 75),
      bytes.slice(75),
    ]);

    expect(output).toContain('"content":"你"');
    expect(output).toContain('"usage":{"total_tokens":2},"choices":[]');
  });

  it('preserves inline config while adding one runtime plugin entry', () => {
    const first = appendOpenAIStreamNormalizerPlugin(
      JSON.stringify({ provider: { test: {} }, plugin: ['existing-plugin'] }),
      '/tmp/openchamber-normalizer.mjs'
    );
    const second = appendOpenAIStreamNormalizerPlugin(first, '/tmp/openchamber-normalizer.mjs');

    expect(JSON.parse(first)).toEqual({
      provider: { test: {} },
      plugin: ['existing-plugin', '/tmp/openchamber-normalizer.mjs'],
    });
    expect(second).toBe(first);
  });

  it('does not replace an invalid user OPENCODE_CONFIG_CONTENT value', () => {
    expect(appendOpenAIStreamNormalizerPlugin('{invalid json', '/tmp/plugin.mjs')).toBe('{invalid json');
  });

  it('does not replace a non-array user plugin field', () => {
    const original = JSON.stringify({ plugin: 'user-plugin' });
    expect(appendOpenAIStreamNormalizerPlugin(original, '/tmp/plugin.mjs')).toBe(original);
  });

  it('writes a process-local plugin and returns an augmented env without touching config files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-normalizer-test-'));
    try {
      const pluginPath = ensureOpenAIStreamNormalizerPluginFile({ preloadDir: dir });
      const env = withOpenAIStreamNormalizerEnv({
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: ['existing-plugin'] }),
      }, { preloadDir: dir });
      const inlineConfig = JSON.parse(env.OPENCODE_CONFIG_CONTENT);

      expect(fs.existsSync(pluginPath)).toBe(true);
      expect(env.OPENCHAMBER_OPENAI_STREAM_NORMALIZER).toBe('1');
      expect(inlineConfig.plugin).toEqual(['existing-plugin', pluginPath]);
      expect(fs.existsSync(path.join(dir, 'opencode.jsonc'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
