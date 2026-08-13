import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { getRuntimeKey } from '@/lib/runtime-switch';
import {
  cancelWalkthroughGeneration,
  fetchWalkthrough,
  fetchWalkthroughStage,
  generateWalkthrough,
} from '@/lib/walkthrough/api';
import {
  WalkthroughError,
  type WalkthroughModel,
  type WalkthroughReadiness,
  type WalkthroughResult,
  type WalkthroughSource,
  type WalkthroughStage,
} from '@/lib/walkthrough/types';

// Walkthroughs live on the server, keyed by repository and source. This store
// is a view cache over that, keyed the same way plus the runtime, so switching
// between a local and a remote runtime never shows one runtime's walkthrough
// for the other's code.

export type WalkthroughEntryStatus = 'idle' | 'loading' | 'generating' | 'ready' | 'error';

export interface WalkthroughEntry {
  status: WalkthroughEntryStatus;
  stage: WalkthroughStage | null;
  result: WalkthroughResult | null;
  readiness: WalkthroughReadiness | null;
  error: {
    message: string;
    code?: WalkthroughError['code'];
    // Carried through so a blocker can name the model that was actually tried
    // rather than the one that happens to be resolved now.
    model?: WalkthroughModel;
    requiredChars?: number;
    availableChars?: number;
  } | null;
}

const EMPTY_ENTRY: WalkthroughEntry = {
  status: 'idle',
  stage: null,
  result: null,
  readiness: null,
  error: null,
};

export const walkthroughSourceKey = (source: WalkthroughSource): string => {
  if (source.kind === 'working-tree') return `working-tree:${source.scope}`;
  if (source.kind === 'branch') return `branch:${source.baseRef}...${source.headRef}`;
  return `pr:${source.number}`;
};

const entryKey = (directory: string, source: WalkthroughSource): string =>
  `${getRuntimeKey()}\0${directory}\0${walkthroughSourceKey(source)}`;

const toError = (error: unknown): WalkthroughEntry['error'] => {
  if (error instanceof WalkthroughError) {
    return {
      message: error.message,
      code: error.code,
      model: error.model,
      requiredChars: error.requiredChars,
      availableChars: error.availableChars,
    };
  }
  return { message: error instanceof Error ? error.message : 'Something went wrong' };
};

interface WalkthroughState {
  entries: Record<string, WalkthroughEntry>;
  /**
   * Source an entry point asked the surface to open with, keyed by directory.
   * Entry points outside the surface (the diff toolbar, a pull request) need a
   * way to say *what* to review; the surface consumes this on mount and the
   * user's own scope choice replaces it.
   */
  requestedSource: Record<string, WalkthroughSource>;
  /**
   * Model the user picked for a specific review, keyed like the entries.
   * Deliberately not persisted: on reopen the model that produced the cached
   * walkthrough is the better default, and it is already stored with it.
   */
  selectedModel: Record<string, string>;
  /**
   * Language the user picked for a specific review, keyed like the entries.
   * Not persisted, for the same reason the model is not: the language of the
   * walkthrough on screen is stored with it, and that is the better default on
   * reopen than any remembered preference.
   */
  selectedLanguage: Record<string, string>;
}

interface WalkthroughActions {
  getEntry: (directory: string, source: WalkthroughSource) => WalkthroughEntry;
  /**
   * Load whatever the server already has. Never generates, never costs tokens.
   *
   * `language` is the fully resolved choice — the store cannot resolve it
   * itself, because the fallback is the interface locale and locale state
   * belongs to `@/lib/i18n`, not here.
   */
  load: (directory: string, source: WalkthroughSource, options?: { language?: string }) => Promise<void>;
  generate: (
    directory: string,
    source: WalkthroughSource,
    options?: { force?: boolean; language?: string }
  ) => Promise<void>;
  cancel: (directory: string, source: WalkthroughSource) => void;
  requestSource: (directory: string, source: WalkthroughSource) => void;
  selectModel: (directory: string, source: WalkthroughSource, model: string | null) => void;
  getSelectedModel: (directory: string, source: WalkthroughSource) => string | undefined;
  selectLanguage: (directory: string, source: WalkthroughSource, language: string | null) => void;
  getSelectedLanguage: (directory: string, source: WalkthroughSource) => string | undefined;
  clearRequestedSource: (directory: string) => void;
  reset: () => void;
}

// Kept outside the store: an AbortController is not state anyone renders, and
// putting it in the store would make every abort a re-render.
const inFlight = new Map<string, AbortController>();
const stagePollers = new Map<string, ReturnType<typeof setInterval>>();

const STAGE_POLL_MS = 1_000;

export const useWalkthroughStore = create<WalkthroughState & WalkthroughActions>()(
  devtools(
    (set, get) => ({
      entries: {},
      requestedSource: {},
      selectedModel: {},
      selectedLanguage: {},

      selectLanguage: (directory, source, language) => {
        const key = entryKey(directory, source);
        set((state) => {
          const next = { ...state.selectedLanguage };
          if (language) next[key] = language;
          else delete next[key];
          return { selectedLanguage: next };
        });
      },

      getSelectedLanguage: (directory, source) => get().selectedLanguage[entryKey(directory, source)],

      selectModel: (directory, source, model) => {
        const key = entryKey(directory, source);
        set((state) => {
          const next = { ...state.selectedModel };
          if (model) next[key] = model;
          else delete next[key];
          return { selectedModel: next };
        });
      },

      getSelectedModel: (directory, source) => get().selectedModel[entryKey(directory, source)],

      requestSource: (directory, source) => {
        set((state) => ({ requestedSource: { ...state.requestedSource, [directory]: source } }));
      },

      clearRequestedSource: (directory) => {
        set((state) => {
          if (!state.requestedSource[directory]) return state;
          const next = { ...state.requestedSource };
          delete next[directory];
          return { requestedSource: next };
        });
      },

      getEntry: (directory, source) => get().entries[entryKey(directory, source)] ?? EMPTY_ENTRY,

      load: async (directory, source, options = {}) => {
        if (!directory) return;
        const key = entryKey(directory, source);
        const current = get().entries[key];
        // A generation in flight owns this entry; a background load must not
        // overwrite its result with the pre-generation state.
        if (current?.status === 'generating') return;

        inFlight.get(key)?.abort();
        const controller = new AbortController();
        inFlight.set(key, controller);

        set((state) => ({
          entries: {
            ...state.entries,
            [key]: { ...(state.entries[key] ?? EMPTY_ENTRY), status: 'loading', error: null },
          },
        }));

        try {
          const result = await fetchWalkthrough(directory, source, {
            model: get().selectedModel[key],
            language: options.language,
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          set((state) => ({
            entries: {
              ...state.entries,
              [key]: { status: 'ready', stage: null, result, readiness: result.readiness ?? null, error: null },
            },
          }));

          // The server is already generating for this source — the user started
          // it and then reloaded or came back. Re-attach so the result lands
          // here instead of being silently completed and forgotten.
          if (result.generating) {
            // The running job already has its own language; this only decides
            // what a request that does *not* attach would ask for.
            void get().generate(directory, source, { language: options.language });
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          // Keep whatever was on screen: a failed read is not evidence that the
          // walkthrough is gone.
          set((state) => ({
            entries: {
              ...state.entries,
              [key]: {
                ...(state.entries[key] ?? EMPTY_ENTRY),
                status: 'error',
                stage: null,
                error: toError(error),
              },
            },
          }));
        } finally {
          if (inFlight.get(key) === controller) inFlight.delete(key);
        }
      },

      generate: async (directory, source, options = {}) => {
        if (!directory) return;
        const key = entryKey(directory, source);

        inFlight.get(key)?.abort();
        const controller = new AbortController();
        inFlight.set(key, controller);

        set((state) => ({
          entries: {
            ...state.entries,
            [key]: { ...(state.entries[key] ?? EMPTY_ENTRY), status: 'generating', stage: 'collecting', error: null },
          },
        }));

        const stopPolling = () => {
          const timer = stagePollers.get(key);
          if (timer === undefined) return;
          clearInterval(timer);
          stagePollers.delete(key);
        };

        stopPolling();
        stagePollers.set(key, setInterval(() => {
          void fetchWalkthroughStage(directory, source)
            .then((stage) => {
              if (!stage || controller.signal.aborted) return;
              set((state) => {
                const entry = state.entries[key];
                if (!entry || entry.status !== 'generating' || entry.stage === stage) return state;
                return { entries: { ...state.entries, [key]: { ...entry, stage } } };
              });
            })
            .catch(() => {
              // A missed poll is not worth surfacing; the next one recovers.
            });
        }, STAGE_POLL_MS));

        try {
          const result = await generateWalkthrough(directory, source, {
            force: options.force,
            model: get().selectedModel[key],
            language: options.language,
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          set((state) => ({
            entries: {
              ...state.entries,
              [key]: {
                status: 'ready',
                stage: null,
                result,
                readiness: state.entries[key]?.readiness ?? null,
                error: null,
              },
            },
          }));
        } catch (error) {
          if (controller.signal.aborted) return;
          set((state) => ({
            entries: {
              ...state.entries,
              [key]: {
                ...(state.entries[key] ?? EMPTY_ENTRY),
                status: 'error',
                stage: null,
                error: toError(error),
              },
            },
          }));
        } finally {
          stopPolling();
          if (inFlight.get(key) === controller) inFlight.delete(key);
        }
      },

      cancel: (directory, source) => {
        const key = entryKey(directory, source);
        // Server-side work outlives this request, so dropping the connection is
        // not enough — cancelling has to be said out loud.
        void cancelWalkthroughGeneration(directory, source).catch(() => {
          // The job may have finished a moment ago; nothing to stop.
        });
        inFlight.get(key)?.abort();
        inFlight.delete(key);
        set((state) => {
          const entry = state.entries[key];
          if (!entry) return state;
          return {
            entries: {
              ...state.entries,
              [key]: { ...entry, status: entry.result ? 'ready' : 'idle', stage: null, error: null },
            },
          };
        });
      },

      reset: () => {
        for (const controller of inFlight.values()) controller.abort();
        inFlight.clear();
        for (const timer of stagePollers.values()) clearInterval(timer);
        stagePollers.clear();
        set({ entries: {}, requestedSource: {}, selectedModel: {}, selectedLanguage: {} });
      },
    }),
    { name: 'walkthrough-store' }
  )
);
