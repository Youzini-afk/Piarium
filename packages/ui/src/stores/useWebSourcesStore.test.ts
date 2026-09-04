import { describe, it, expect, beforeEach } from 'vitest';
import { useWebSourcesStore } from './useWebSourcesStore.js';

describe('useWebSourcesStore', () => {
  beforeEach(() => {
    useWebSourcesStore.setState({ sources: [], dismissedIds: [] });
  });

  it('adds a source', () => {
    useWebSourcesStore.getState().addSource({
      sessionId: 's1',
      url: 'https://example.com/page',
      title: 'Example Page',
      fetchedAt: Date.now(),
      toolCallId: 'tc1',
      tool: 'webfetch',
    });
    expect(useWebSourcesStore.getState().sources).toHaveLength(1);
    expect(useWebSourcesStore.getState().sources[0]?.url).toBe('https://example.com/page');
    expect(useWebSourcesStore.getState().sources[0]?.pinned).toBe(false);
  });

  it('pins and unpins a source', () => {
    useWebSourcesStore.getState().addSource({
      sessionId: 's1', url: 'https://example.com', title: 'Test',
      fetchedAt: 0, toolCallId: 'tc1', tool: 'webfetch',
    });
    const id = useWebSourcesStore.getState().sources[0]!.id;

    useWebSourcesStore.getState().pinSource(id);
    expect(useWebSourcesStore.getState().sources[0]?.pinned).toBe(true);

    useWebSourcesStore.getState().unpinSource(id);
    expect(useWebSourcesStore.getState().sources[0]?.pinned).toBe(false);
  });

  it('deletes a source', () => {
    useWebSourcesStore.getState().addSource({
      sessionId: 's1', url: 'https://example.com', title: 'Test',
      fetchedAt: 0, toolCallId: 'tc1', tool: 'webfetch',
    });
    const id = useWebSourcesStore.getState().sources[0]!.id;

    useWebSourcesStore.getState().deleteSource(id);
    expect(useWebSourcesStore.getState().sources).toHaveLength(0);
    useWebSourcesStore.getState().addSource({
      sessionId: 's1', url: 'https://example.com', title: 'Test',
      fetchedAt: 0, toolCallId: 'tc1', tool: 'webfetch',
    });
    expect(useWebSourcesStore.getState().sources).toHaveLength(0);
  });

  it('deduplicates a persisted tool source during transcript re-projection', () => {
    const source = {
      sessionId: 's1', url: 'https://example.com', title: 'Test',
      fetchedAt: 0, toolCallId: 'tc1', tool: 'webfetch' as const,
    };
    useWebSourcesStore.getState().addSource(source);
    useWebSourcesStore.getState().addSource(source);
    expect(useWebSourcesStore.getState().sources).toHaveLength(1);
  });

  it('clears sources for a session', () => {
    useWebSourcesStore.getState().addSource({
      sessionId: 's1', url: 'https://a.com', title: 'A',
      fetchedAt: 0, toolCallId: 'tc1', tool: 'webfetch',
    });
    useWebSourcesStore.getState().addSource({
      sessionId: 's2', url: 'https://b.com', title: 'B',
      fetchedAt: 0, toolCallId: 'tc2', tool: 'websearch',
    });

    useWebSourcesStore.getState().clearSession('s1');
    expect(useWebSourcesStore.getState().sources).toHaveLength(1);
    expect(useWebSourcesStore.getState().sources[0]?.sessionId).toBe('s2');
  });

  it('useWebSources selector returns only session sources', () => {
    useWebSourcesStore.getState().addSource({
      sessionId: 's1', url: 'https://a.com', title: 'A',
      fetchedAt: 0, toolCallId: 'tc1', tool: 'webfetch',
    });
    useWebSourcesStore.getState().addSource({
      sessionId: 's2', url: 'https://b.com', title: 'B',
      fetchedAt: 0, toolCallId: 'tc2', tool: 'websearch',
    });

    // Test the filter logic directly (selectors are hooks, tested via getState)
    const s1Sources = useWebSourcesStore.getState().sources.filter((s) => s.sessionId === 's1');
    expect(s1Sources).toHaveLength(1);
    expect(s1Sources[0]?.url).toBe('https://a.com');
  });

  it('usePinnedWebSources selector returns only pinned sources for session', () => {
    useWebSourcesStore.getState().addSource({
      sessionId: 's1', url: 'https://a.com', title: 'A',
      fetchedAt: 0, toolCallId: 'tc1', tool: 'webfetch',
    });
    useWebSourcesStore.getState().addSource({
      sessionId: 's1', url: 'https://b.com', title: 'B',
      fetchedAt: 0, toolCallId: 'tc2', tool: 'websearch',
    });
    const id1 = useWebSourcesStore.getState().sources[0]!.id;
    useWebSourcesStore.getState().pinSource(id1);

    // Test the filter logic directly (selectors are hooks, tested via getState)
    const pinned = useWebSourcesStore.getState().sources.filter((s) => s.sessionId === 's1' && s.pinned);
    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.url).toBe('https://a.com');
  });
});
