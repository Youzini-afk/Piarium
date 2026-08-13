import { describe, expect, it } from 'vitest';
import { __testing } from './index.js';

const catalog = {
  provider: {
    models: {
      model: { limit: { context: 2_000 } },
    },
  },
};

describe('small-model input budget', () => {
  it('counts the system instruction as model input', () => {
    expect(() => __testing.clampPromptToModelLimit({
      prompt: 'p'.repeat(3_001),
      system: 's'.repeat(1_000),
      catalog,
      providerID: 'provider',
      modelID: 'model',
      outputReserveTokens: 1_000,
      onOverflow: 'error',
    })).toThrow(expect.objectContaining({
      code: 'context-too-small',
      requiredChars: 4_001,
      availableChars: 4_000,
    }));
  });

  it('only truncates the prompt and leaves room for the system instruction', () => {
    const result = __testing.clampPromptToModelLimit({
      prompt: 'p'.repeat(3_500),
      system: 's'.repeat(1_000),
      catalog,
      providerID: 'provider',
      modelID: 'model',
      outputReserveTokens: 1_000,
      onOverflow: 'truncate',
    });

    expect(result.truncated).toBe(true);
    expect(result.prompt.length + 1_000).toBe(4_000);
  });
});
