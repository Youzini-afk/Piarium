import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { requestIdeSearch, subscribeIdeSearchRequests } from './ide-search-events';

beforeEach(() => vi.stubGlobal('window', new EventTarget()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('IDE search request ownership', () => {
  test('reports whether the active shell handled a request', () => {
    expect(requestIdeSearch({ mode: 'content' })).toBe(false);
    const listener = vi.fn();
    const unsubscribe = subscribeIdeSearchRequests(listener);

    expect(requestIdeSearch({ mode: 'content' })).toBe(true);
    expect(listener).toHaveBeenCalledWith({ mode: 'content' });

    unsubscribe();
    expect(requestIdeSearch({ mode: 'files' })).toBe(false);
  });

  test('does not let a staged shell claim the request', () => {
    const unsubscribe = subscribeIdeSearchRequests(() => false);
    expect(requestIdeSearch({ mode: 'content' })).toBe(false);
    unsubscribe();
  });
});
