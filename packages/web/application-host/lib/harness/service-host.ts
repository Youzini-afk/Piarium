import { createOutputStore, type OutputStore } from "./output-store.js";
import { createPathLockService, type PathLockService } from "./path-lock.js";
import { createShellSupervisor, selectInterpreter, type ShellInterpreter, type ShellSupervisor } from "./shell-supervisor.js";
import { createHarnessSearchService, type HarnessSearchService } from "./search-service.js";
import type { DiagnosticsProvider } from "./diagnostics-service.js";
import type { WorkspaceContentSearchResult } from "../search/content.js";
import type { KnowledgeStore } from "../knowledge/store.js";
import type { MemoryAgentSettings } from "@piarium/protocol";
import type { Zone2ContextUsage, Zone2Material } from "./zone2.js";
import type { CompactionHandlerDeps, CompactionSettings } from "./compaction.js";
import type { TodoToolDeps, TodoToolSettings } from "./todo-tool.js";
import type { RecallToolDeps } from "./recall-tool.js";
import type { createLspNavigationServices } from "./lsp-nav.js";
import type { ThreadRegistry } from "./thread-registry.js";
import type { ThreadTranscriptReader } from "./thread-transcript.js";
import { createObservationCursorStore, type ObservationCursorStore } from "./observation-cursors.js";
import type {
  HarnessActorContext,
  HarnessActorIdentity,
  HarnessCapability,
} from "@piarium/protocol";

export interface HarnessSessionContext {
  actor: HarnessActorIdentity;
  grantedCapabilities: readonly HarnessCapability[] | Promise<readonly HarnessCapability[]>;
  workspaceId: string | null;
  workspaceRoot: string;
}

interface SessionEntry {
  actor: Omit<HarnessActorIdentity, "runId">;
  grantedCapabilities: Promise<readonly HarnessCapability[]>;
  shellSupervisor: ShellSupervisor | null;
  interpreter: ShellInterpreter | { unavailable: { reason: string; hint: string } };
  workspaceId: string | null;
  workspaceRoot: string;
  workspaceScope?: readonly string[];
}

export function deriveHarnessCapabilities(
  activeTools: readonly string[],
  availability: { threadRuntime: boolean },
): readonly HarnessCapability[] {
  const tools = new Set(activeTools);
  const capabilities = new Set<HarnessCapability>([
    // Hidden session extensions use these even when their corresponding
    // user-facing tools are not shown.
    "context.session",
    "read.lsp",
    "read.output",
  ]);
  if (tools.has("grep")) capabilities.add("read.search");
  if (tools.has("webfetch") || tools.has("websearch")) capabilities.add("read.web");
  if (tools.has("bash")) capabilities.add("process.shell");
  if (tools.has("write") || tools.has("edit") || tools.has("apply_patch")) capabilities.add("write.document");
  if (
    availability.threadRuntime
    && ["dispatch", "threads", "wait", "send", "read_thread", "merge", "kill"].some((name) => tools.has(name))
  ) {
    capabilities.add("control.thread");
  }
  return [...capabilities];
}

export interface HarnessServiceHost {
  outputStore: OutputStore;
  observationCursors: ObservationCursorStore;
  pathLockService: PathLockService;
  searchService: HarnessSearchService;
  diagnosticsProvider: DiagnosticsProvider | null;
  lspNavigationServices: ReturnType<typeof createLspNavigationServices> | null;
  webFetchService: { fetch: (url: string, ctx: { workspaceId: string; render?: boolean }) => Promise<import("@piarium/protocol").FetchResult> } | null;
  webReadService: import("./router.js").HarnessService<"web.read"> | null;
  webSearchService: import("./router.js").HarnessService<"web.search"> | null;
  // Phase 2: knowledge, memory, zone2, compaction, todo, recall
  knowledgeStore: KnowledgeStore | null;
  userKnowledgeStore: KnowledgeStore | null;
  memoryDepsProvider: ((sessionId: string) => Promise<{ store: KnowledgeStore; settings: MemoryAgentSettings }>) | null;
  zone2Provider: ((request: { afterEventId?: number; contextUsage: Zone2ContextUsage | null; query?: string; sessionId: string; sinceTurn: number }) => Promise<{ eventCursor: number; material: Zone2Material }>) | null;
  onSessionCompacted: ((sessionId: string) => void) | null;
  compactionDepsProvider: ((sessionId: string) => Promise<CompactionHandlerDeps>) | null;
  compactionSettings: CompactionSettings;
  todoSettings: TodoToolSettings;
  recallDepsProvider: ((sessionId: string) => Promise<RecallToolDeps>) | null;
  todoDepsProvider: ((sessionId: string) => Promise<TodoToolDeps>) | null;
  // Phase 3: Thread registry
  threadRegistry: ThreadRegistry | null;
  threadSpawnSession: ((input: import("./thread-registry.js").CreateThreadInput & { threadId: string; runId: string }) => Promise<{ sessionId: string }>) | null;
  threadKillSession: ((threadId: string) => Promise<void>) | null;
  threadApplyWorktreeDiff: ((workspaceId: string, parent: import("@piarium/protocol").ThreadParent, threadId: string) => Promise<{
    merged: number;
    conflicts: string[];
    conflictState?: "none" | "markers" | "parent-unchanged";
    changedFiles?: string[];
    diffStats?: import("@piarium/protocol").ThreadDiffStats;
  }>) | null;
  threadSendToSession: ((sessionId: string, message: string, from: "user" | "parent-agent") => Promise<void>) | null;
  threadTranscriptReader: ThreadTranscriptReader | null;
  registerSession(ctx: HarnessSessionContext): void;
  dropSession(sessionId: string, actor?: HarnessActorIdentity): void;
  hasActor(identity: HarnessActorIdentity): boolean;
  resolveActor(identity: HarnessActorIdentity): Promise<HarnessActorContext | null>;
  getShellSupervisor(sessionId: string): ShellSupervisor | null;
  getInterpreter(sessionId: string): ShellInterpreter | { unavailable: { reason: string; hint: string } } | null;
  dispose(): Promise<void>;
}

export interface HarnessServiceHostOptions {
  search: (request: { query: string; workspaceId: string; maxResults?: number; paths?: string[] }, options: { signal?: AbortSignal }) => Promise<WorkspaceContentSearchResult>;
  resolveWorkspaceRoot: (workspaceId: string) => Promise<string | null>;
  diagnosticsProvider?: DiagnosticsProvider;
  lspNavigationServices?: ReturnType<typeof createLspNavigationServices>;
  shellSetting?: "auto" | "git-bash" | "powershell" | "wsl";
  discoveredShells?: { gitBashPath?: string; wslDistros?: string[]; hasBash?: boolean; hasPowerShell?: boolean };
  remote?: boolean;
  /**
   * Called when a session's shell supervisor is created to register a
   * process-mode writer with the document authority. Returns a handle
   * with a close() method, or null if registration is not available.
   */
  registerWriter?: (sessionId: string, workspaceRoot: string) => Promise<{ close: () => Promise<void> } | null>;
  /** Web fetch service (null on cloud/web hosts without fetch capability) */
  webFetchService?: HarnessServiceHost["webFetchService"];
  /** Web read service (null when no reader model configured) */
  webReadService?: HarnessServiceHost["webReadService"];
  /** Web search service (null when no search provider available) */
  webSearchService?: HarnessServiceHost["webSearchService"];
  // Phase 2 options
  knowledgeStore?: KnowledgeStore;
  userKnowledgeStore?: KnowledgeStore;
  memoryDepsProvider?: (sessionId: string) => Promise<{ store: KnowledgeStore; settings: MemoryAgentSettings }>;
  zone2Provider?: (request: { afterEventId?: number; contextUsage: Zone2ContextUsage | null; query?: string; sessionId: string; sinceTurn: number }) => Promise<{ eventCursor: number; material: Zone2Material }>;
  onSessionCompacted?: (sessionId: string) => void;
  compactionDepsProvider?: (sessionId: string) => Promise<CompactionHandlerDeps>;
  compactionSettings?: CompactionSettings;
  todoSettings?: TodoToolSettings;
  recallDepsProvider?: (sessionId: string) => Promise<RecallToolDeps>;
  todoDepsProvider?: (sessionId: string) => Promise<TodoToolDeps>;
  // Phase 3 options
  threadRegistry?: ThreadRegistry;
  threadSpawnSession?: (input: import("./thread-registry.js").CreateThreadInput & { threadId: string; runId: string }) => Promise<{ sessionId: string }>;
  threadKillSession?: (threadId: string) => Promise<void>;
  threadApplyWorktreeDiff?: HarnessServiceHost["threadApplyWorktreeDiff"];
  threadSendToSession?: (sessionId: string, message: string, from: "user" | "parent-agent") => Promise<void>;
  threadTranscriptReader?: ThreadTranscriptReader;
}

export function createHarnessServiceHost(options: HarnessServiceHostOptions): HarnessServiceHost {
  const outputStore = createOutputStore();
  const observationCursors = createObservationCursorStore();
  const pathLockService = createPathLockService();
  const searchService = createHarnessSearchService({
    search: options.search,
    resolveWorkspaceRoot: options.resolveWorkspaceRoot,
  });
  const diagnosticsProvider = options.diagnosticsProvider ?? null;
  const lspNavigationServices = options.lspNavigationServices ?? null;
  const webFetchService = options.webFetchService ?? null;
  const webReadService = options.webReadService ?? null;
  const webSearchService = options.webSearchService ?? null;
  // Phase 2
  const knowledgeStore = options.knowledgeStore ?? null;
  const userKnowledgeStore = options.userKnowledgeStore ?? null;
  const memoryDepsProvider = options.memoryDepsProvider ?? null;
  const zone2Provider = options.zone2Provider ?? null;
  const onSessionCompacted = options.onSessionCompacted ?? null;
  const compactionDepsProvider = options.compactionDepsProvider ?? null;
  const compactionSettings = options.compactionSettings ?? { keepTurns: 8, reinjectFileLimit: 5, reinjectFileTokens: 5000, reinjectTotalTokens: 50000, reinjectSkillsTokens: 25000 };
  const todoSettings = options.todoSettings ?? { confirmBelow: 0.6 };
  const recallDepsProvider = options.recallDepsProvider ?? null;
  const todoDepsProvider = options.todoDepsProvider ?? null;
  // Phase 3
  const threadRegistry = options.threadRegistry ?? null;
  const threadSpawnSession = options.threadSpawnSession ?? null;
  const threadKillSession = options.threadKillSession ?? null;
  const threadApplyWorktreeDiff = options.threadApplyWorktreeDiff ?? null;
  const threadSendToSession = options.threadSendToSession ?? null;
  const threadTranscriptReader = options.threadTranscriptReader ?? null;

  const sessions = new Map<string, SessionEntry>();

  const registerSession = (ctx: HarnessSessionContext): void => {
    const sessionId = ctx.actor.sessionId;
    const previous = sessions.get(sessionId);
    if (previous) {
      void previous.shellSupervisor?.dispose();
      observationCursors.clearKind(sessionId, "shell");
    }
    const interpreterResult = selectInterpreter({
      platform: process.platform,
      workspaceRoot: ctx.workspaceRoot,
      setting: options.shellSetting ?? "auto",
      discovered: options.discoveredShells ?? {},
      remote: options.remote ?? false,
    });

    let shellSupervisor: ShellSupervisor | null = null;
    if ("kind" in interpreterResult) {
      shellSupervisor = createShellSupervisor({
        interpreter: interpreterResult,
        outputStore,
        sessionId,
        cwd: ctx.workspaceRoot ?? undefined,
        ...(options.registerWriter ? {
          registerWriter: () => options.registerWriter!(sessionId, ctx.workspaceRoot),
        } : {}),
      });
    }

    const actor = {
      authorityInstanceId: ctx.actor.authorityInstanceId,
      sessionId,
      workerId: ctx.actor.workerId,
      workerGeneration: ctx.actor.workerGeneration,
    };
    sessions.set(sessionId, {
      actor,
      grantedCapabilities: Promise.resolve(ctx.grantedCapabilities).then((capabilities) => (
        Object.freeze([...new Set(capabilities)])
      )),
      shellSupervisor,
      interpreter: interpreterResult,
      workspaceId: ctx.workspaceId,
      workspaceRoot: ctx.workspaceRoot,
      ...(ctx.actor.workspaceScope?.length ? { workspaceScope: [...ctx.actor.workspaceScope] } : {}),
    });
  };

  const dropSession = (sessionId: string, actor?: HarnessActorIdentity): void => {
    const entry = sessions.get(sessionId);
    if (actor && (!entry || !hasActor(actor))) return;
    if (entry) {
      void entry.shellSupervisor?.dispose();
      sessions.delete(sessionId);
    }
    outputStore.dropSession(sessionId);
    observationCursors.clearObserver(sessionId);
    threadRegistry?.clearCursorsForSession(sessionId);
    pathLockService.dropSession(sessionId);
  };

  const getShellSupervisor = (sessionId: string): ShellSupervisor | null => {
    return sessions.get(sessionId)?.shellSupervisor ?? null;
  };

  const getInterpreter = (sessionId: string): ShellInterpreter | { unavailable: { reason: string; hint: string } } | null => {
    return sessions.get(sessionId)?.interpreter ?? null;
  };

  const hasActor = (identity: HarnessActorIdentity): boolean => {
    const entry = sessions.get(identity.sessionId);
    return Boolean(
      entry
      && entry.actor.authorityInstanceId === identity.authorityInstanceId
      && entry.actor.workerId === identity.workerId
      && entry.actor.workerGeneration === identity.workerGeneration
    );
  };

  const resolveActor = async (identity: HarnessActorIdentity): Promise<HarnessActorContext | null> => {
    const entry = sessions.get(identity.sessionId);
    if (!entry || !hasActor(identity)) return null;
    return {
      ...identity,
      workspaceId: entry.workspaceId,
      ...(entry.workspaceScope ? { workspaceScope: entry.workspaceScope } : {}),
      grantedCapabilities: await entry.grantedCapabilities,
    };
  };

  const dispose = async (): Promise<void> => {
    const disposes: Promise<void>[] = [];
    for (const entry of sessions.values()) {
      if (entry.shellSupervisor) disposes.push(entry.shellSupervisor.dispose());
    }
    sessions.clear();
    await Promise.all(disposes);
    outputStore.dispose();
    observationCursors.dispose();
    pathLockService.dispose();
    if (knowledgeStore) disposes.push(knowledgeStore.close());
    if (userKnowledgeStore) disposes.push(userKnowledgeStore.close());
    await Promise.all(disposes);
  };

  return {
    outputStore,
    observationCursors,
    pathLockService,
    searchService,
    diagnosticsProvider,
    lspNavigationServices,
    webFetchService,
    webReadService,
    webSearchService,
    knowledgeStore,
    userKnowledgeStore,
    memoryDepsProvider,
    zone2Provider,
    onSessionCompacted,
    compactionDepsProvider,
    compactionSettings,
    todoSettings,
    recallDepsProvider,
    todoDepsProvider,
    threadRegistry,
    threadSpawnSession,
    threadKillSession,
    threadApplyWorktreeDiff,
    threadSendToSession,
    threadTranscriptReader,
    registerSession,
    dropSession,
    hasActor,
    resolveActor,
    getShellSupervisor,
    getInterpreter,
    dispose,
  };
}
