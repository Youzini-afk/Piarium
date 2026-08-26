import { describe, expect, test } from 'vitest';
import { shouldRenderPiExtensionStatus } from './piExtensionUiStatus';

describe('Pi extension UI chrome', () => {
  test('does not duplicate statuses owned by first-class Piarium controls', () => {
    expect(shouldRenderPiExtensionStatus('mcp')).toBe(false);
    expect(shouldRenderPiExtensionStatus('pi-permission-system')).toBe(false);
    expect(shouldRenderPiExtensionStatus('third-party-extension')).toBe(true);
  });
});
