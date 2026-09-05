import type { DocumentMutationObservation } from "../documents/authority.js";
import type { Zone2ContextUsage, Zone2Material } from "../harness/zone2.js";
import { createObservers, type DiagnosticEvent, type GitStatusEvent, type Observers, type TerminalExitEvent } from "./observers.js";
import type { KnowledgeStore, StoredEvent } from "./store.js";

interface SessionBinding {
  gitFingerprint: string | null;
  observers: Promise<Observers | null> | null;
  pendingUserPaths: Set<string>;
  sessionId: string;
  tail: Promise<void>;
  turnIndex: number;
  workspaceId: string;
}

export interface KnowledgeContextRuntimeOptions {
  getStore(workspaceId: string): Promise<KnowledgeStore | null>;
  onError?: (error: unknown) => void;
}

export interface Zone2MaterialRequest {
  afterEventId?: number;
  contextUsage: Zone2ContextUsage | null;
  query?: string;
  sessionId: string;
  sinceTurn: number;
  /** Branch entry IDs for ancestor-resolution block filtering. */
  branchEntryIds?: string[];
}

export interface Zone2MaterialResult {
  eventCursor: number;
  material: Zone2Material;
}

const emptyMaterial = (contextUsage: Zone2ContextUsage | null): Zone2Material => ({
  userEdits: [],
  userCommands: [],
  newDiagnostics: [],
  git: null,
  knowledge: [],
  blocks: [],
  contextUsage,
});

const isAgentOwner = (kind: string): boolean => (
  kind === "pi-worker" || kind.startsWith("harness-")
);

const dataOf = (event: StoredEvent): Record<string, unknown> => event.data ?? {};

export function createKnowledgeContextRuntime(options: KnowledgeContextRuntimeOptions) {
  const sessions = new Map<string, SessionBinding>();
  const pending = new Set<Promise<void>>();
  let disposed = false;

  const track = (task: Promise<void>): void => {
    pending.add(task);
    void task.catch((error) => options.onError?.(error)).finally(() => pending.delete(task));
  };

  const bindSession = (sessionId: string, workspaceId: string): void => {
    const current = sessions.get(sessionId);
    if (current?.workspaceId === workspaceId) return;
    sessions.set(sessionId, {
      observers: null,
      gitFingerprint: null,
      pendingUserPaths: new Set(),
      sessionId,
      tail: current?.tail ?? Promise.resolve(),
      turnIndex: current?.turnIndex ?? 0,
      workspaceId,
    });
  };

  const observersFor = async (binding: SessionBinding): Promise<Observers | null> => {
    if (binding.observers) return binding.observers;
    const loading = options.getStore(binding.workspaceId).then((store) => (
      store ? createObservers({ store, sessionId: binding.sessionId }) : null
    ));
    binding.observers = loading;
    void loading.catch(() => {
      if (binding.observers === loading) binding.observers = null;
    });
    return loading;
  };

  const forWorkspace = (
    workspaceId: string,
    visit: (observers: Observers, binding: SessionBinding) => Promise<void>,
  ): Promise<void> => Promise.all([...sessions.values()]
    .filter((binding) => binding.workspaceId === workspaceId)
    .map((binding) => {
      const task = binding.tail.then(async () => {
        const observers = await observersFor(binding);
        if (observers) await visit(observers, binding);
      });
      binding.tail = task.catch(() => undefined);
      return task;
    }))
    .then(() => undefined);

  const observeDocumentMutation = (event: DocumentMutationObservation): void => {
    if (disposed) return;
    const agentWriterActive = isAgentOwner(event.owner.kind);
    track(forWorkspace(event.workspaceId, (observers, binding) => {
      if (agentWriterActive) binding.pendingUserPaths.delete(event.resourceId);
      else binding.pendingUserPaths.add(event.resourceId);
      return observers.onDocumentWrite({
        workspaceId: event.workspaceId,
        path: event.resourceId,
        kind: event.kind,
        agentWriterActive,
        turnIndex: binding.turnIndex,
      });
    }));
  };

  const observeTerminalExit = (event: TerminalExitEvent): void => {
    if (disposed) return;
    track(forWorkspace(event.workspaceId, (observers, binding) => observers.onTerminalExit({
      ...event,
      turnIndex: binding.turnIndex,
    })));
  };

  const observeDiagnostics = (event: DiagnosticEvent): void => {
    if (disposed) return;
    track(forWorkspace(event.workspaceId, async (observers, binding) => {
      // A diagnostic enters Zone 2 only when it follows a user-authored
      // document mutation. Agent-authored diagnostics are already visible in
      // tool results and must not be repeated as "news" on the next turn.
      if (!binding.pendingUserPaths.delete(event.path)) return;
      await observers.onDiagnostics({
        ...event,
        turnIndex: binding.turnIndex,
      });
    }));
  };

  const observeGitStatus = (event: GitStatusEvent): void => {
    if (disposed) return;
    const fingerprint = JSON.stringify([event.branch ?? null, event.changed ?? null, event.note ?? null]);
    track(forWorkspace(event.workspaceId, async (observers, binding) => {
      if (binding.gitFingerprint === fingerprint) return;
      await observers.onGitStatus({
        ...event,
        turnIndex: binding.turnIndex,
      });
      binding.gitFingerprint = fingerprint;
    }));
  };

  const zone2Material = async (request: Zone2MaterialRequest): Promise<Zone2MaterialResult> => {
    const binding = sessions.get(request.sessionId);
    if (!binding) {
      return { eventCursor: request.afterEventId ?? 0, material: emptyMaterial(request.contextUsage) };
    }
    binding.turnIndex = Math.max(binding.turnIndex, request.sinceTurn + 1);
    // A document commit deliberately does not wait for observational storage.
    // The next model turn is the synchronization point: include every event
    // already queued for this session before advancing its cursor.
    await binding.tail;
    const store = await options.getStore(binding.workspaceId);
    if (!store) {
      return { eventCursor: request.afterEventId ?? 0, material: emptyMaterial(request.contextUsage) };
    }
    const events = await store.listEvents({
      sessionId: request.sessionId,
      ...(request.afterEventId === undefined
        ? { minTurnIndex: request.sinceTurn }
        : { afterId: request.afterEventId }),
    });
    const material = emptyMaterial(request.contextUsage);
    let eventCursor = request.afterEventId ?? 0;
    for (const event of events) {
      eventCursor = Math.max(eventCursor, event.id);
      const data = dataOf(event);
      if (event.kind === "edit" && event.source !== "agent") {
        const kind = data.kind;
        const path = data.path ?? event.refs?.path;
        if ((kind === "modified" || kind === "created" || kind === "deleted") && typeof path === "string") {
          material.userEdits.push({ kind, path });
        }
      } else if (event.kind === "command" && event.source !== "agent") {
        const command = data.command;
        const exitCode = data.exitCode;
        if (typeof command === "string" && typeof exitCode === "number") {
          material.userCommands.push({ command, exitCode, at: event.at });
        }
      } else if (event.kind === "diagnostic" && event.source !== "agent") {
        const path = data.path ?? event.refs?.path;
        const count = data.count;
        const worst = data.worst;
        if (typeof path === "string" && typeof count === "number" && (worst === "error" || worst === "warning")) {
          material.newDiagnostics.push({ path, count, worst });
        }
      } else if (event.kind === "source" && data.type === "git") {
        material.git = {
          ...(typeof data.branch === "string" ? { branch: data.branch } : {}),
          ...(typeof data.changed === "number" ? { changed: data.changed } : {}),
          ...(typeof data.note === "string" ? { note: data.note } : {}),
        };
      }
    }
    material.blocks = (await store.getBlocks(
      request.sessionId,
      request.branchEntryIds === undefined ? undefined : request.branchEntryIds,
    )).map((block) => ({
      label: block.label,
      content: block.content,
    }));
    if (request.query?.trim()) {
      const recalled = await store.recall(request.query, 5);
      material.knowledge = recalled.flatMap((result) => {
        if (result.node.type !== "knowledge") return [];
        const content = result.node.payload.content;
        const trigger = result.node.payload.trigger;
        return typeof content === "string" && typeof trigger === "string"
          ? [{ id: result.node.id, title: content, trigger }]
          : [];
      });
    }
    return { eventCursor, material };
  };

  const dropSession = (sessionId: string): void => {
    sessions.delete(sessionId);
  };

  const resetSessionObservationBaselines = (sessionId: string): void => {
    const binding = sessions.get(sessionId);
    if (binding) binding.gitFingerprint = null;
  };

  const drain = async (): Promise<void> => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    sessions.clear();
    await drain();
  };

  return {
    bindSession,
    dispose,
    drain,
    dropSession,
    observeDiagnostics,
    observeDocumentMutation,
    observeGitStatus,
    observeTerminalExit,
    resetSessionObservationBaselines,
    zone2Material,
  };
}

export type KnowledgeContextRuntime = ReturnType<typeof createKnowledgeContextRuntime>;
