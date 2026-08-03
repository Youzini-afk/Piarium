import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

export interface ReviewSessionLink {
  directory: string;
  originalSessionId: string;
  reviewSessionId: string;
  runtimeKey: string;
}

interface ReviewFlowState {
  linksByOriginal: Record<string, ReviewSessionLink>;
  removeLink(runtimeKey: string, originalSessionId: string): void;
  upsertLink(link: ReviewSessionLink): void;
}

export const reviewLinkKey = (runtimeKey: string, originalSessionId: string): string => (
  `${runtimeKey}:${originalSessionId}`
);

export const useReviewFlowStore = create<ReviewFlowState>()(
  persist(
    (set) => ({
      linksByOriginal: {},
      removeLink: (runtimeKey, originalSessionId) => set((state) => {
        const key = reviewLinkKey(runtimeKey, originalSessionId);
        if (!(key in state.linksByOriginal)) return state;
        const linksByOriginal = { ...state.linksByOriginal };
        delete linksByOriginal[key];
        return { linksByOriginal };
      }),
      upsertLink: (link) => set((state) => ({
        linksByOriginal: {
          ...state.linksByOriginal,
          [reviewLinkKey(link.runtimeKey, link.originalSessionId)]: link,
        },
      })),
    }),
    {
      name: 'piarium-review-flow-links',
      storage: createDeferredSafeJSONStorage(),
      partialize: (state) => ({ linksByOriginal: state.linksByOriginal }),
    },
  ),
);
