import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PATCHED_SYMBOL = Symbol.for('openchamber:normalize-openai-stream:patched');
const ORIGINAL_FETCH_SYMBOL = Symbol.for('openchamber:normalize-openai-stream:originalFetch');
const PLUGIN_FILE_NAME = 'openai-stream-normalizer-plugin.mjs';

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeOpenAIStreamLine(line) {
  if (typeof line !== 'string' || !line.startsWith('data: ')) {
    return line;
  }

  const payload = line.slice(6);
  const suffix = payload.endsWith('\r') ? '\r' : '';
  const jsonPayload = suffix ? payload.slice(0, -1) : payload;
  if (jsonPayload === '[DONE]') {
    return line;
  }

  try {
    const obj = JSON.parse(jsonPayload);
    if (
      obj
      && typeof obj === 'object'
      && obj.object === 'chat.completion.chunk'
      && hasOwn(obj, 'usage')
      && !hasOwn(obj, 'choices')
    ) {
      obj.choices = [];
      return `data: ${JSON.stringify(obj)}${suffix}`;
    }
  } catch {
    // Non-JSON SSE data is not ours to interpret.
  }

  return line;
}

function createOpenAIStreamNormalizeTransform() {
  let buffer = '';
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        controller.enqueue(encoder.encode(`${normalizeOpenAIStreamLine(line)}\n`));
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.length > 0) {
        controller.enqueue(encoder.encode(normalizeOpenAIStreamLine(buffer)));
      }
    },
  });
}

function getFetchUrl(input) {
  if (typeof input === 'string') return input;
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
  if (input && typeof input === 'object' && typeof input.url === 'string') return input.url;
  return '';
}

function shouldNormalizeOpenAIStreamResponse(url, response) {
  if (!String(url || '').includes('/chat/completions')) return false;
  const contentType = response?.headers?.get?.('content-type') || '';
  if (!String(contentType).toLowerCase().includes('text/event-stream')) return false;
  return Boolean(response?.body?.pipeThrough);
}

function installOpenAIStreamFetchNormalizer(target = globalThis) {
  if (!target || target[PATCHED_SYMBOL]) return false;
  const originalFetch = target.fetch;
  if (typeof originalFetch !== 'function') return false;

  if (!target[ORIGINAL_FETCH_SYMBOL]) {
    target[ORIGINAL_FETCH_SYMBOL] = originalFetch;
  }

  target.fetch = async function openChamberNormalizedFetch(input, init) {
    const url = getFetchUrl(input);
    const response = await originalFetch.call(this, input, init);
    if (!shouldNormalizeOpenAIStreamResponse(url, response)) {
      return response;
    }

    const headers = new Headers(response.headers);
    headers.delete('content-length');

    return new Response(response.body.pipeThrough(createOpenAIStreamNormalizeTransform()), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

  target[PATCHED_SYMBOL] = true;
  return true;
}

const OPENAI_STREAM_NORMALIZER_PLUGIN_SOURCE = `
// Auto-generated OpenChamber managed OpenCode compatibility plugin.
// It only normalizes malformed OpenAI-compatible streaming usage chunks and
// is injected through OPENCODE_CONFIG_CONTENT without touching user config files.
const PATCHED_SYMBOL = Symbol.for('openchamber:normalize-openai-stream:patched');
const ORIGINAL_FETCH_SYMBOL = Symbol.for('openchamber:normalize-openai-stream:originalFetch');
const hasOwn = ${hasOwn.toString()};
const normalizeOpenAIStreamLine = ${normalizeOpenAIStreamLine.toString()};
const createOpenAIStreamNormalizeTransform = ${createOpenAIStreamNormalizeTransform.toString()};
const getFetchUrl = ${getFetchUrl.toString()};
const shouldNormalizeOpenAIStreamResponse = ${shouldNormalizeOpenAIStreamResponse.toString()};
const installOpenAIStreamFetchNormalizer = ${installOpenAIStreamFetchNormalizer.toString()};
export const server = async () => {
  installOpenAIStreamFetchNormalizer(globalThis);
  return {
    dispose: async () => {},
  };
};
export default server;
`;

function getDefaultPreloadDir() {
  return path.join(os.tmpdir(), 'openchamber-managed-opencode');
}

function ensureOpenAIStreamNormalizerPluginFile(options = {}) {
  const preloadDir = options.preloadDir || getDefaultPreloadDir();
  const preloadPath = path.join(preloadDir, PLUGIN_FILE_NAME);
  fs.mkdirSync(preloadDir, { recursive: true });

  const content = `${OPENAI_STREAM_NORMALIZER_PLUGIN_SOURCE.trim()}\n`;
  let shouldWrite = true;
  try {
    shouldWrite = fs.readFileSync(preloadPath, 'utf8') !== content;
  } catch {
    shouldWrite = true;
  }
  if (shouldWrite) {
    fs.writeFileSync(preloadPath, content, 'utf8');
  }
  return preloadPath;
}

function parseInlineConfigContent(value) {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return null;
  }
}

function appendOpenAIStreamNormalizerPlugin(existingConfigContent, pluginPath) {
  const config = parseInlineConfigContent(existingConfigContent);
  if (config === null) {
    return existingConfigContent;
  }
  if (hasOwn(config, 'plugin') && !Array.isArray(config.plugin)) {
    return existingConfigContent;
  }
  const plugin = Array.isArray(config.plugin) ? [...config.plugin] : [];
  if (!plugin.includes(pluginPath)) {
    plugin.push(pluginPath);
  }
  return JSON.stringify({
    ...config,
    plugin,
  });
}

function withOpenAIStreamNormalizerEnv(env = process.env, options = {}) {
  const pluginPath = ensureOpenAIStreamNormalizerPluginFile(options);
  const nextConfigContent = appendOpenAIStreamNormalizerPlugin(env.OPENCODE_CONFIG_CONTENT, pluginPath);
  const skipped = nextConfigContent === env.OPENCODE_CONFIG_CONTENT;
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT: nextConfigContent,
    OPENCHAMBER_OPENAI_STREAM_NORMALIZER: skipped ? 'skipped-user-inline-config' : '1',
  };
}

export {
  OPENAI_STREAM_NORMALIZER_PLUGIN_SOURCE,
  appendOpenAIStreamNormalizerPlugin,
  createOpenAIStreamNormalizeTransform,
  ensureOpenAIStreamNormalizerPluginFile,
  installOpenAIStreamFetchNormalizer,
  normalizeOpenAIStreamLine,
  withOpenAIStreamNormalizerEnv,
};
