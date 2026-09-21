import React from 'react';
import type { ThreadParent } from '@varin/protocol';
import { runtimeFetch } from '@varin/application-client';
import { subscribeVarinEvents } from '@/lib/varinEvents';
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
  const [researchRoot, setResearchRoot] = React.useState<HarnessThreadSnapshot | null>(null);
  const researchRootRef = React.useRef<HarnessThreadSnapshot | null>(null);
  const [researchBranches, setResearchBranches] = React.useState<HarnessThreadSnapshot[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
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
    if (snapshot.thread.purpose === 'research-root') {
      const current = researchRootRef.current;
      if (current && current.thread.eventSeq > snapshot.thread.eventSeq) return;
      researchRootRef.current = snapshot;
      setResearchRoot(snapshot);
      return;
    }
    if (snapshot.thread.parent.kind === 'thread' && snapshot.thread.parent.id === researchRootRef.current?.thread.id) {
      setResearchBranches((current) => mergeHarnessThreadSnapshot(current, snapshot, { includeArchived: includeArchivedRef.current }));
      return;
    }
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
    setLoadError(null);
    commitScope({ workspaceId: projection.workspaceId, parent: projection.parent });
    if (eventRevision.current === revisionAtStart
      || (projection.researchRoot && (!researchRootRef.current
        || projection.researchRoot.thread.eventSeq >= researchRootRef.current.thread.eventSeq))) {
      researchRootRef.current = projection.researchRoot;
      setResearchRoot(projection.researchRoot);
    }
    setResearchBranches((current) => eventRevision.current === revisionAtStart
      ? projection.researchBranches
      : projection.researchBranches.reduce((list, snapshot) => (
        mergeHarnessThreadSnapshot(list, snapshot, { includeArchived: includeArchivedRef.current })
      ), current));
    setThreads((current) => {
      const ordinary = projection.threads.filter(({ thread }) => thread.purpose !== 'research-root');
      if (eventRevision.current === revisionAtStart) return ordinary;
      return ordinary.reduce(
        (list, snapshot) => mergeHarnessThreadSnapshot(list, snapshot, { includeArchived: includeArchivedRef.current }),
        current,
      );
    });
  }, [commitScope, parentSessionId]);

  React.useEffect(() => {
    const controller = new AbortController();
    eventRevision.current = 0;
    setThreads([]);
    researchRootRef.current = null;
    setResearchRoot(null);
    setResearchBranches([]);
    setLoadError(null);
    commitScope({ workspaceId: workspaceId ?? '', parent: { kind: 'session', id: parentSessionId } });
    if (!workspaceId) return () => controller.abort();
    void reload(controller.signal).catch((error) => {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : String(error));
    });
    const unsubscribe = subscribeVarinEvents((event) => {
      if (event.type === 'stream-ready') {
        void reload(controller.signal).catch((error) => {
          if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : String(error));
        });
        return;
      }
      if (
        event.type !== 'harness-thread-changed'
        || event.workspaceId !== scopeRef.current.workspaceId
        || (!sameHarnessThreadParent(event.parent, scopeRef.current.parent)
          && !(event.parent.kind === 'thread' && event.parent.id === researchRootRef.current?.thread.id))
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
      setLoadError(error instanceof Error ? error.message : String(error));
    });
  }, [reload]);

  const value = React.useMemo<HarnessThreadStateValue>(() => ({
    includeArchived,
    merge,
    parent: scope.parent,
    reload,
    setIncludeArchived: setIncludeArchivedAndReload,
    threads,
    researchRoot,
    researchBranches,
    loadError,
    workspaceId: scope.workspaceId,
  }), [includeArchived, merge, reload, scope.parent, scope.workspaceId, setIncludeArchivedAndReload, threads, researchRoot, researchBranches, loadError]);

  return <HarnessThreadStateContext.Provider value={value}>{children}</HarnessThreadStateContext.Provider>;
};
