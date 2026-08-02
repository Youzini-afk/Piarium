import React from 'react';
import type { RuntimeContextTarget } from '@piarium/protocol';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';

export const useResourceRuntimeTarget = (): {
  runtimeTarget: RuntimeContextTarget;
  targetKey: string;
} => {
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const sessionId = usePiSessionStore((state) => {
    const current = state.currentSessionId;
    return current && state.records[current]?.open ? current : null;
  });
  const runtimeTarget = React.useMemo<RuntimeContextTarget>(() => (
    sessionId ? { sessionId } : { cwd: currentDirectory }
  ), [currentDirectory, sessionId]);
  return {
    runtimeTarget,
    targetKey: JSON.stringify([
      getRuntimeKey(),
      sessionId ? 'session' : 'cwd',
      sessionId ?? currentDirectory,
    ]),
  };
};
