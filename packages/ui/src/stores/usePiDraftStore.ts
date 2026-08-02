import type { ImageAttachment } from '@piarium/protocol';
import { create } from 'zustand';
import { getRuntimeKey } from '@/lib/runtime-switch';

export interface PiDraftState {
  images: ImageAttachment[];
  text: string;
}

interface PiDraftStoreState {
  drafts: Record<string, PiDraftState>;
  appendText(sessionId: string, text: string): void;
  clear(sessionId: string): void;
  setDraft(sessionId: string, update: Partial<PiDraftState>): void;
}

export const EMPTY_PI_DRAFT: PiDraftState = { images: [], text: '' };

export const piDraftKey = (sessionId: string, runtimeKey = getRuntimeKey()): string => (
  JSON.stringify([runtimeKey, sessionId])
);

export const readPiDraft = (sessionId: string): PiDraftState => (
  usePiDraftStore.getState().drafts[piDraftKey(sessionId)] ?? EMPTY_PI_DRAFT
);

export const fileToPiImageAttachment = (file: File): Promise<ImageAttachment> => new Promise((resolve, reject) => {
  if (!file.type.startsWith('image/')) {
    reject(new Error(`${file.name || 'Attachment'} is not an image`));
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
  reader.onload = () => {
    const value = typeof reader.result === 'string' ? reader.result : '';
    const separator = value.indexOf(',');
    if (separator === -1) {
      reject(new Error(`Could not decode ${file.name}`));
      return;
    }
    resolve({ data: value.slice(separator + 1), mimeType: file.type });
  };
  reader.readAsDataURL(file);
});

export const addPiDraftImageFile = async (sessionId: string, file: File): Promise<void> => {
  const attachment = await fileToPiImageAttachment(file);
  const current = readPiDraft(sessionId);
  usePiDraftStore.getState().setDraft(sessionId, { images: [...current.images, attachment] });
};

export const usePiDraftStore = create<PiDraftStoreState>((set) => ({
  drafts: {},
  appendText: (sessionId, text) => {
    const normalized = text.trim();
    if (!sessionId || !normalized) return;
    const key = piDraftKey(sessionId);
    set((state) => {
      const current = state.drafts[key] ?? EMPTY_PI_DRAFT;
      return {
        drafts: {
          ...state.drafts,
          [key]: {
            ...current,
            text: [current.text.trimEnd(), normalized]
              .filter((value) => value.length > 0)
              .join('\n\n'),
          },
        },
      };
    });
  },
  clear: (sessionId) => {
    const key = piDraftKey(sessionId);
    set((state) => {
      if (!(key in state.drafts)) return state;
      const drafts = { ...state.drafts };
      delete drafts[key];
      return { drafts };
    });
  },
  setDraft: (sessionId, update) => {
    if (!sessionId) return;
    const key = piDraftKey(sessionId);
    set((state) => ({
      drafts: {
        ...state.drafts,
        [key]: {
          ...(state.drafts[key] ?? EMPTY_PI_DRAFT),
          ...update,
        },
      },
    }));
  },
}));
