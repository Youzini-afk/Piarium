import { withOpenAIStreamNormalizerEnv } from '../../web/server/lib/opencode/openai-stream-normalizer.js';

export function buildManagedOpenCodeSpawnEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return withOpenAIStreamNormalizerEnv(baseEnv) as NodeJS.ProcessEnv;
}
