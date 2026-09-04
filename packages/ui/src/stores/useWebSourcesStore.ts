import { create } from 'zustand';

export interface WebSource {
  id: string;
  sessionId: string;
  url: string;
  title: string;
  fetchedAt: number;
  toolCallId: string;
  tool: 'webfetch' | 'websearch';
  pinned: boolean;
}

interface WebSourcesState {
  sources: WebSource[];
  dismissedIds: string[];
  addSource: (source: Omit<WebSource, 'id' | 'pinned'>) => void;
  pinSource: (id: string) => void;
  unpinSource: (id: string) => void;
  deleteSource: (id: string) => void;
  clearSession: (sessionId: string) => void;
}

const sourceId = (source: Pick<WebSource, 'sessionId' | 'toolCallId' | 'url'>): string => (
  `${source.sessionId}\0${source.toolCallId}\0${source.url}`
);

export const useWebSourcesStore = create<WebSourcesState>()((set) => ({
  sources: [],
  dismissedIds: [],
  addSource: (source) => set((state) => {
    const id = sourceId(source);
    if (state.dismissedIds.includes(id) || state.sources.some((entry) => entry.id === id)) return state;
    return { sources: [...state.sources, { ...source, id, pinned: false }] };
  }),
  pinSource: (id) => set((state) => ({
    sources: state.sources.map((s) => s.id === id ? { ...s, pinned: true } : s),
  })),
  unpinSource: (id) => set((state) => ({
    sources: state.sources.map((s) => s.id === id ? { ...s, pinned: false } : s),
  })),
  deleteSource: (id) => set((state) => ({
    sources: state.sources.filter((s) => s.id !== id),
    dismissedIds: state.dismissedIds.includes(id) ? state.dismissedIds : [...state.dismissedIds, id],
  })),
  clearSession: (sessionId) => set((state) => ({
    sources: state.sources.filter((s) => s.sessionId !== sessionId),
    dismissedIds: state.dismissedIds.filter((id) => !id.startsWith(`${sessionId}\0`)),
  })),
}));

// Leaf selectors per stores/DOCUMENTATION.md selector rules
export const useWebSources = (sessionId: string): WebSource[] =>
  useWebSourcesStore((state) => state.sources.filter((s) => s.sessionId === sessionId));

export const usePinnedWebSources = (sessionId: string): WebSource[] =>
  useWebSourcesStore((state) => state.sources.filter((s) => s.sessionId === sessionId && s.pinned));
