import { describe, expect, test } from 'vitest';
import { shouldRenderPiExtensionStatus } from './piExtensionUiStatus';

describe('Pi extension UI chrome', () => {
  test('does not duplicate statuses owned by first-class Varin controls', () => {
    expect(shouldRenderPiExtensionStatus('mcp')).toBe(false);
    expect(shouldRenderPiExtensionStatus('third-party-extension')).toBe(true);
  });
});
