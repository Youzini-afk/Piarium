import React from 'react';
import type { ThreadParent } from '@piarium/protocol';
import { runtimeFetch } from '@piarium/application-client';
import { subscribePiariumEvents } from '@/lib/piariumEvents';
import {
  mergeHarnessThreadSnapshot,
  parseHarnessThreadProjection,
  sameHarnessThreadParent,
  type HarnessThreadSnapshot,
} from './harnessThreadPresentation';
import { HarnessThreadStateContext, type HarnessThreadStateValue } from './HarnessThreadStateContext';

export const HarnessThreadStateProvider: React.FC<{
  children: React.ReactNode;
  parentSessionId: string;
  workspaceId: string | null;
}> = ({ children, parentSessionId, workspaceId }) => {
  const [threads, setThreads] = React.useState<HarnessThreadSnapshot[]>([]);
  const [scope, setScope] = React.useState<{ parent: ThreadParent; workspaceId: string }>({
    parent: { kind: 'session', id: parentSessionId },
    workspaceId: workspaceId ?? '',
  });
  const scopeRef = React.useRef(scope);
  const eventRevision = React.useRef(0);

  const commitScope = React.useCallback((next: { parent: ThreadParent; workspaceId: string }) => {
    scopeRef.current = next;
    setScope((current) => (
      current.workspaceId === next.workspaceId && sameHarnessThreadParent(current.parent, next.parent)
        ? current
        : next
    ));
  }, []);

  const merge = React.useCallback((snapshot: HarnessThreadSnapshot) => {
    eventRevision.current += 1;
    setThreads((current) => mergeHarnessThreadSnapshot(current, snapshot));
  }, []);

  const reload = React.useCallback(async (signal?: AbortSignal) => {
    const revisionAtStart = eventRevision.current;
    const response = await runtimeFetch(`/api/harness/sessions/${encodeURIComponent(parentSessionId)}/threads`, {
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      if (response.status === 404) return;
      throw new Error(`Unable to load threads (${response.status})`);
    }
    const projection = parseHarnessThreadProjection(await response.json());
    commitScope({ workspaceId: projection.workspaceId, parent: projection.parent });
    setThreads((current) => {
      if (eventRevision.current === revisionAtStart) return projection.threads;
      return projection.threads.reduce(mergeHarnessThreadSnapshot, current);
    });
  }, [commitScope, parentSessionId]);

  React.useEffect(() => {
    const controller = new AbortController();
    eventRevision.current = 0;
    setThreads([]);
    commitScope({ workspaceId: workspaceId ?? '', parent: { kind: 'session', id: parentSessionId } });
    if (!workspaceId) return () => controller.abort();
    void reload(controller.signal).catch((error) => {
      if (!controller.signal.aborted) console.warn('[HarnessThreadState] Failed to load threads:', error);
    });
    const unsubscribe = subscribePiariumEvents((event) => {
      if (event.type === 'stream-ready') {
        void reload(controller.signal).catch(() => undefined);
        return;
      }
      if (
        event.type !== 'harness-thread-changed'
        || event.workspaceId !== scopeRef.current.workspaceId
        || !sameHarnessThreadParent(event.parent, scopeRef.current.parent)
      ) return;
      merge({ thread: event.thread, activeRun: event.activeRun });
    });
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [commitScope, merge, parentSessionId, reload, workspaceId]);

  const value = React.useMemo<HarnessThreadStateValue>(() => ({
    merge,
    parent: scope.parent,
    threads,
    workspaceId: scope.workspaceId,
  }), [merge, scope.parent, scope.workspaceId, threads]);

  return <HarnessThreadStateContext.Provider value={value}>{children}</HarnessThreadStateContext.Provider>;
};
