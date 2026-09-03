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
  addSource: (source: Omit<WebSource, 'id' | 'pinned'>) => void;
  pinSource: (id: string) => void;
  unpinSource: (id: string) => void;
  deleteSource: (id: string) => void;
  clearSession: (sessionId: string) => void;
}

let idCounter = 0;
const nextId = (): string => `ws_${++idCounter}`;

export const useWebSourcesStore = create<WebSourcesState>()((set) => ({
  sources: [],
  addSource: (source) => set((state) => ({
    sources: [...state.sources, { ...source, id: nextId(), pinned: false }],
  })),
  pinSource: (id) => set((state) => ({
    sources: state.sources.map((s) => s.id === id ? { ...s, pinned: true } : s),
  })),
  unpinSource: (id) => set((state) => ({
    sources: state.sources.map((s) => s.id === id ? { ...s, pinned: false } : s),
  })),
  deleteSource: (id) => set((state) => ({
    sources: state.sources.filter((s) => s.id !== id),
  })),
  clearSession: (sessionId) => set((state) => ({
    sources: state.sources.filter((s) => s.sessionId !== sessionId),
  })),
}));

// Leaf selectors per stores/DOCUMENTATION.md selector rules
export const useWebSources = (sessionId: string): WebSource[] =>
  useWebSourcesStore((state) => state.sources.filter((s) => s.sessionId === sessionId));

export const usePinnedWebSources = (sessionId: string): WebSource[] =>
  useWebSourcesStore((state) => state.sources.filter((s) => s.sessionId === sessionId && s.pinned));
