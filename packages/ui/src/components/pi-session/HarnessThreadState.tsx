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
  const [includeArchived, setIncludeArchived] = React.useState(false);
  const includeArchivedRef = React.useRef(false);
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
    setThreads((current) => mergeHarnessThreadSnapshot(current, snapshot, { includeArchived: includeArchivedRef.current }));
  }, []);

  const reload = React.useCallback(async (signal?: AbortSignal) => {
    const revisionAtStart = eventRevision.current;
    const query = includeArchivedRef.current ? '?archived=1' : '';
    const response = await runtimeFetch(`/api/harness/sessions/${encodeURIComponent(parentSessionId)}/threads${query}`, {
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      if (response.status === 404) return;
      throw new Error(`Unable to load threads (${response.status})`);
    }
    const projection = parseHarnessThreadProjection(await response.json(), { includeArchived: includeArchivedRef.current });
    commitScope({ workspaceId: projection.workspaceId, parent: projection.parent });
    setThreads((current) => {
      if (eventRevision.current === revisionAtStart) return projection.threads;
      return projection.threads.reduce(
        (list, snapshot) => mergeHarnessThreadSnapshot(list, snapshot, { includeArchived: includeArchivedRef.current }),
        current,
      );
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

  const setIncludeArchivedAndReload = React.useCallback((value: boolean) => {
    includeArchivedRef.current = value;
    setIncludeArchived(value);
    void reload().catch((error) => {
      console.warn('[HarnessThreadState] Failed to reload threads:', error);
    });
  }, [reload]);

  const value = React.useMemo<HarnessThreadStateValue>(() => ({
    includeArchived,
    merge,
    parent: scope.parent,
    reload,
    setIncludeArchived: setIncludeArchivedAndReload,
    threads,
    workspaceId: scope.workspaceId,
  }), [includeArchived, merge, reload, scope.parent, scope.workspaceId, setIncludeArchivedAndReload, threads]);

  return <HarnessThreadStateContext.Provider value={value}>{children}</HarnessThreadStateContext.Provider>;
};
