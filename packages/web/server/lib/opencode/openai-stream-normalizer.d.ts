export const OPENAI_STREAM_NORMALIZER_PLUGIN_SOURCE: string;

export function appendOpenAIStreamNormalizerPlugin(
  existingConfigContent: string | undefined,
  pluginPath: string,
): string | undefined;

export function createOpenAIStreamNormalizeTransform(): TransformStream<Uint8Array, Uint8Array>;

export function ensureOpenAIStreamNormalizerPluginFile(options?: { preloadDir?: string }): string;

export function installOpenAIStreamFetchNormalizer(target?: typeof globalThis): boolean;

export function normalizeOpenAIStreamLine(line: string): string;

export function withOpenAIStreamNormalizerEnv(
  env?: NodeJS.ProcessEnv,
  options?: { preloadDir?: string },
): Record<string, string | undefined>;
