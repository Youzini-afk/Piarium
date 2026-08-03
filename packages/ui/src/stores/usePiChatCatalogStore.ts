import { create } from 'zustand';
import type { RuntimeContextTarget } from '@piarium/protocol';
import { subscribePiRuntimeCatalogChanged } from '@/lib/pi-runtime/catalog-events';
import { buildPiChatCatalog, type PiChatCatalog } from '@/lib/pi-runtime/chat-catalog';
import { listPiCommands } from '@/lib/pi-runtime/commands';
import { listPiResources } from '@/lib/pi-runtime/resources';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

export interface PiChatCatalogEntry extends PiChatCatalog {
  error: string | null;
  loaded: boolean;
  loading: boolean;
}

interface PiChatCatalogStore {
  entries: Record<string, PiChatCatalogEntry>;
  epoch: number;
  invalidate(targetKey?: string): void;
  load(
    target: RuntimeContextTarget,
    targetKey: string,
    force?: boolean,
  ): Promise<void>;
}

interface PiChatCatalogStoreDependencies {
  getRuntimeKey(): string;
  listCommands: typeof listPiCommands;
  listResources: typeof listPiResources;
}

export const EMPTY_PI_CHAT_CATALOG_ENTRY: PiChatCatalogEntry = {
  commands: [],
  error: null,
  loaded: false,
  loading: false,
  skills: [],
};

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

export const createPiChatCatalogTargetKey = (
  target: RuntimeContextTarget,
  runtimeKey = getRuntimeKey(),
): string => JSON.stringify([
  runtimeKey,
  'sessionId' in target ? 'session' : 'cwd',
  'sessionId' in target ? target.sessionId : target.cwd,
]);

export const createPiChatCatalogStore = (
  dependencies: PiChatCatalogStoreDependencies,
) => {
  const inFlight = new Map<string, Promise<void>>();
  const generations = new Map<string, number>();
  let globalGeneration = 0;

  return create<PiChatCatalogStore>()((set, get) => ({
    entries: {},
    epoch: 0,

    invalidate: (targetKey) => {
      if (targetKey) {
        generations.set(targetKey, (generations.get(targetKey) ?? 0) + 1);
        inFlight.delete(targetKey);
        set((state) => {
          const entries = { ...state.entries };
          delete entries[targetKey];
          return { entries, epoch: state.epoch + 1 };
        });
        return;
      }

      globalGeneration += 1;
      generations.clear();
      inFlight.clear();
      set((state) => ({ entries: {}, epoch: state.epoch + 1 }));
    },

    load: (target, targetKey, force = false) => {
      const current = get().entries[targetKey];
      const pending = inFlight.get(targetKey);
      if (pending) return pending;
      if (!force && (current?.loaded || current?.loading)) return Promise.resolve();

      const runtimeKey = dependencies.getRuntimeKey();
      const requestGlobalGeneration = globalGeneration;
      const generation = (generations.get(targetKey) ?? 0) + 1;
      generations.set(targetKey, generation);
      set((state) => ({
        entries: {
          ...state.entries,
          [targetKey]: {
            ...(state.entries[targetKey] ?? EMPTY_PI_CHAT_CATALOG_ENTRY),
            error: null,
            loading: true,
          },
        },
      }));

      const request = Promise.all([
        dependencies.listCommands(target),
        dependencies.listResources(target, 'skill'),
      ]).then(([commands, skills]) => {
        if (
          globalGeneration !== requestGlobalGeneration
          || generations.get(targetKey) !== generation
          || dependencies.getRuntimeKey() !== runtimeKey
        ) return;
        const catalog = buildPiChatCatalog(commands, skills);
        set((state) => ({
          entries: {
            ...state.entries,
            [targetKey]: {
              ...catalog,
              error: null,
              loaded: true,
              loading: false,
            },
          },
        }));
      }).catch((error: unknown) => {
        if (
          globalGeneration !== requestGlobalGeneration
          || generations.get(targetKey) !== generation
          || dependencies.getRuntimeKey() !== runtimeKey
        ) return;
        set((state) => ({
          entries: {
            ...state.entries,
            [targetKey]: {
              ...(state.entries[targetKey] ?? EMPTY_PI_CHAT_CATALOG_ENTRY),
              error: errorMessage(error),
              loading: false,
            },
          },
        }));
      }).finally(() => {
        if (inFlight.get(targetKey) === request) inFlight.delete(targetKey);
      });

      inFlight.set(targetKey, request);
      return request;
    },
  }));
};

export const usePiChatCatalogStore = createPiChatCatalogStore({
  getRuntimeKey,
  listCommands: listPiCommands,
  listResources: listPiResources,
});

subscribeRuntimeEndpointChanged(() => {
  usePiChatCatalogStore.getState().invalidate();
});

subscribePiRuntimeCatalogChanged(() => {
  usePiChatCatalogStore.getState().invalidate();
});
