import { describe, expect, it } from 'vitest';
import { isPiAbortError } from './abort';

describe('isPiAbortError', () => {
  it('recognizes AbortError control flow', () => {
    expect(isPiAbortError(new DOMException('This operation was aborted', 'AbortError'))).toBe(true);
    const named = new Error('cancelled');
    named.name = 'AbortError';
    expect(isPiAbortError(named)).toBe(true);
  });

  it('recognizes common aborted-operation messages but not real failures', () => {
    expect(isPiAbortError(new Error('This operation was aborted'))).toBe(true);
    expect(isPiAbortError(new Error('The request was aborted by the user'))).toBe(true);
    expect(isPiAbortError(new Error('Provider connection failed'))).toBe(false);
  });
});
