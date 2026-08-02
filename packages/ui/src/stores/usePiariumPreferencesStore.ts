import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

interface PiariumPreferencesState {
  dictationEnabled: boolean;
  setDictationEnabled(enabled: boolean): void;
  setSttLocalModel(model: string): void;
  sttApiKey: string;
  sttLanguage: string;
  sttLocalModel: string;
  sttModel: string;
  sttProvider: 'local' | 'openai-compatible';
  sttServerUrl: string;
}

const readPreviousBoolean = (key: string, fallback: boolean): boolean => {
  if (typeof window === 'undefined') return fallback;
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value !== 'false';
  } catch {
    return fallback;
  }
};

const readPreviousString = (key: string, fallback: string): string => {
  if (typeof window === 'undefined') return fallback;
  try {
    return window.localStorage.getItem(key)?.trim() || fallback;
  } catch {
    return fallback;
  }
};

export const usePiariumPreferencesStore = create<PiariumPreferencesState>()(
  persist(
    (set) => ({
      dictationEnabled: readPreviousBoolean('dictationEnabled', true),
      setDictationEnabled: (dictationEnabled) => set({ dictationEnabled }),
      setSttLocalModel: (sttLocalModel) => set({ sttLocalModel: sttLocalModel.trim() }),
      sttApiKey: readPreviousString('sttApiKey', ''),
      sttLanguage: readPreviousString('sttLanguage', ''),
      sttLocalModel: readPreviousString('sttLocalModel', 'parakeet-tdt-0.6b-v2-int8'),
      sttModel: readPreviousString('sttModel', 'deepdml/faster-whisper-large-v3-turbo-ct2'),
      sttProvider: readPreviousString('sttProvider', 'local') === 'openai-compatible'
        ? 'openai-compatible'
        : 'local',
      sttServerUrl: readPreviousString('sttServerUrl', 'http://localhost:8001/v1'),
    }),
    {
      name: 'piarium-preferences',
      storage: createDeferredSafeJSONStorage(),
      partialize: (state) => ({
        dictationEnabled: state.dictationEnabled,
        sttApiKey: state.sttApiKey,
        sttLanguage: state.sttLanguage,
        sttLocalModel: state.sttLocalModel,
        sttModel: state.sttModel,
        sttProvider: state.sttProvider,
        sttServerUrl: state.sttServerUrl,
      }) as PiariumPreferencesState,
    },
  ),
);
