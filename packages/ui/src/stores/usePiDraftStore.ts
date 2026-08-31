import type { ImageAttachment, ModelDescriptor, ThinkingLevel } from '@piarium/protocol';
import { create } from 'zustand';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeKey } from '@piarium/application-client';
import type { PiComposerAgentSelection } from '@/lib/pi-runtime/composerAgent';

export interface PiDraftState {
  /** Optional provider-native Agent target for the next submitted message. */
  agent?: PiComposerAgentSelection;
  images: ImageAttachment[];
  instructions?: string;
  /** Explicit next-session model. Undefined means inherit the effective default. */
  model?: Pick<ModelDescriptor, 'id' | 'provider'>;
  text: string;
  /** Explicit next-session thinking level. Undefined means inherit the effective default. */
  thinkingLevel?: ThinkingLevel;
}

interface PiDraftStoreState {
  drafts: Record<string, PiDraftState>;
  appendText(sessionId: string, text: string): void;
  clear(sessionId: string, runtimeKey?: string): void;
  setDraft(sessionId: string, update: Partial<PiDraftState>, runtimeKey?: string): void;
  setPendingDraft(cwd: string, update: Partial<PiDraftState>, runtimeKey?: string): void;
  transferPendingDraft(cwd: string, sessionId: string, runtimeKey?: string): PiDraftState;
}

export const EMPTY_PI_DRAFT: PiDraftState = { images: [], text: '' };

export const piDraftKey = (sessionId: string, runtimeKey = getRuntimeKey()): string => (
  JSON.stringify([runtimeKey, sessionId])
);

export const piPendingDraftKey = (cwd: string, runtimeKey = getRuntimeKey()): string => (
  JSON.stringify([runtimeKey, 'workspace', normalizePath(cwd) ?? cwd.trim()])
);

export const readPiDraft = (sessionId: string, runtimeKey = getRuntimeKey()): PiDraftState => (
  usePiDraftStore.getState().drafts[piDraftKey(sessionId, runtimeKey)] ?? EMPTY_PI_DRAFT
);

export const readPiPendingDraft = (cwd: string, runtimeKey = getRuntimeKey()): PiDraftState => (
  usePiDraftStore.getState().drafts[piPendingDraftKey(cwd, runtimeKey)] ?? EMPTY_PI_DRAFT
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

export const usePiDraftStore = create<PiDraftStoreState>((set, get) => ({
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
  clear: (sessionId, runtimeKey = getRuntimeKey()) => {
    const key = piDraftKey(sessionId, runtimeKey);
    set((state) => {
      if (!(key in state.drafts)) return state;
      const drafts = { ...state.drafts };
      delete drafts[key];
      return { drafts };
    });
  },
  setDraft: (sessionId, update, runtimeKey = getRuntimeKey()) => {
    if (!sessionId) return;
    const key = piDraftKey(sessionId, runtimeKey);
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
  setPendingDraft: (cwd, update, runtimeKey = getRuntimeKey()) => {
    if (!cwd.trim()) return;
    const key = piPendingDraftKey(cwd, runtimeKey);
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
  transferPendingDraft: (cwd, sessionId, runtimeKey = getRuntimeKey()) => {
    if (!cwd.trim() || !sessionId) return EMPTY_PI_DRAFT;
    const pendingKey = piPendingDraftKey(cwd, runtimeKey);
    const sessionKey = piDraftKey(sessionId, runtimeKey);
    const pendingDraft = get().drafts[pendingKey];
    if (!pendingDraft) return EMPTY_PI_DRAFT;
    set((state) => {
      const current = state.drafts[pendingKey];
      if (!current) return state;
      const drafts = { ...state.drafts, [sessionKey]: current };
      delete drafts[pendingKey];
      return { drafts };
    });
    return pendingDraft;
  },
}));
