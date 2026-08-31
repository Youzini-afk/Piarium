import React from 'react';
import type { RuntimeContextTarget } from '@piarium/protocol';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@piarium/application-client';
import {
  createPiChatCatalogTargetKey,
  EMPTY_PI_CHAT_CATALOG_ENTRY,
  usePiChatCatalogStore,
  type PiChatCatalogEntry,
} from '@/stores/usePiChatCatalogStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';

interface UsePiChatCatalogOptions {
  cwd?: string | null;
  refreshOnMount?: boolean;
  sessionId?: string | null;
}

interface UsePiChatCatalogResult extends PiChatCatalogEntry {
  refresh(): Promise<void>;
  runtimeTarget: RuntimeContextTarget | null;
  targetKey: string | null;
}

const subscribeRuntimeKey = (notify: () => void): (() => void) => (
  subscribeRuntimeEndpointChanged(() => notify())
);

export const usePiChatCatalog = (
  options: UsePiChatCatalogOptions = {},
): UsePiChatCatalogResult => {
  const fallbackDirectory = useEffectiveDirectory();
  const activeSessionId = usePiSessionStore((state) => {
    const current = state.currentSessionId;
    return current && state.records[current]?.open ? current : null;
  });
  const runtimeKey = React.useSyncExternalStore(
    subscribeRuntimeKey,
    getRuntimeKey,
    getRuntimeKey,
  );
  const explicitWorkspace = options.cwd !== undefined;
  const sessionId = options.sessionId !== undefined
    ? options.sessionId?.trim() || null
    : explicitWorkspace
      ? null
      : activeSessionId;
  const cwd = options.cwd?.trim() || fallbackDirectory || null;
  const runtimeTarget = React.useMemo<RuntimeContextTarget | null>(() => (
    sessionId ? { sessionId } : cwd ? { cwd } : null
  ), [cwd, sessionId]);
  const targetKey = React.useMemo(() => (
    runtimeTarget ? createPiChatCatalogTargetKey(runtimeTarget, runtimeKey) : null
  ), [runtimeKey, runtimeTarget]);
  const entry = usePiChatCatalogStore((state) => (
    targetKey ? state.entries[targetKey] : undefined
  ));
  const epoch = usePiChatCatalogStore((state) => state.epoch);
  const load = usePiChatCatalogStore((state) => state.load);

  React.useEffect(() => {
    if (!runtimeTarget || !targetKey) return;
    void load(runtimeTarget, targetKey, options.refreshOnMount === true);
  }, [epoch, load, options.refreshOnMount, runtimeTarget, targetKey]);

  const refresh = React.useCallback(() => (
    runtimeTarget && targetKey
      ? load(runtimeTarget, targetKey, true)
      : Promise.resolve()
  ), [load, runtimeTarget, targetKey]);

  return {
    ...(entry ?? EMPTY_PI_CHAT_CATALOG_ENTRY),
    refresh,
    runtimeTarget,
    targetKey,
  };
};
