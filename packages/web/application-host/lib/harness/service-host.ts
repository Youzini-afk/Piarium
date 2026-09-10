import { createOutputStore, type OutputStore } from "./output-store.js";
import { createPathLockService, type PathLockService } from "./path-lock.js";
import { discoverShells } from "./shell-discovery.js";
import type { HarnessShellSetting } from "./harness-shell-settings.js";
import { createShellSupervisor, selectInterpreter, type ShellInterpreter, type ShellSupervisor } from "./shell-supervisor.js";
import { createHarnessSearchService, type HarnessSearchDeps, type HarnessSearchService } from "./search-service.js";
import type { DiagnosticsProvider } from "./diagnostics-service.js";
import type { ExploreFileReader } from "./explore-file-reader.js";
import { createExploreQueryStore, type ExploreQueryStore } from "./explore-query-store.js";
import type { KnowledgeStore } from "../knowledge/store.js";
import type { MemoryAgentSettings } from "@piarium/protocol";
import type { Zone2MaterialRequest, Zone2MaterialResult } from "../knowledge/context-runtime.js";
import type { CompactionHandlerDeps, CompactionSettings, KeeperCoverageStore } from "./compaction.js";
import { createKeeperCoverageStore } from "./compaction.js";
import type { TodoToolDeps, TodoToolSettings } from "./todo-tool.js";
import type { RecallToolDeps } from "./recall-tool.js";
import type { createLspNavigationServices } from "./lsp-nav.js";
import type { StructureSource } from "../structure/types.js";
import type { ThreadRegistry } from "./thread-registry.js";
import type { ThreadTranscriptReader } from "./thread-transcript.js";
import type { CapturedThreadDraftBaseline } from "./thread-runtime.js";
import { createObservationCursorStore, type ObservationCursorStore } from "./observation-cursors.js";
import type {
  HarnessActorContext,
  HarnessActorIdentity,
  HarnessCapability,
  AgentInputContext,
} from "@piarium/protocol";
import type {
  SurfaceSnapshotOverlayResult,
  SurfaceSnapshotReadResult,
} from "../documents/surface-snapshot-store.js";

export interface HarnessSessionContext {
  actor: HarnessActorIdentity;
  grantedCapabilities: readonly HarnessCapability[] | Promise<readonly HarnessCapability[]>;
  workspaceId: string | null;
  workspaceRoot: string;
  /** Resolved for this workspace at session register. Host-wide options are only a fallback. */
  shellSetting?: HarnessShellSetting;
  shellResolution?: { invalid: { reason: string; hint: string } };
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
  availability: { documentRead?: boolean; documentPathOverlay?: boolean; threadRuntime: boolean },
): readonly HarnessCapability[] {
  const tools = new Set(activeTools);
  const capabilities = new Set<HarnessCapability>([
    // Hidden session extensions use these even when their corresponding
    // user-facing tools are not shown.
    "context.session",
    "read.lsp",
    "read.output",
  ]);
  if (tools.has("grep") || tools.has("explore")) capabilities.add("read.search");
  if (availability.documentRead && tools.has("read")) capabilities.add("read.document");
  if (availability.documentPathOverlay && (tools.has("find") || tools.has("ls"))) capabilities.add("read.document");
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

/** Read-source lookup used by the native Pi read wrapper. */
export type HarnessDocumentReadSource = (
  sessionId: string,
  context: AgentInputContext,
  resourceId: string,
) => SurfaceSnapshotReadResult;

/** Write admission for native Pi write/edit/apply_patch wrappers (D-089). */
export type HarnessDocumentWriteGuard = (
  sessionId: string,
  context: AgentInputContext,
  resourceId: string,
) => Promise<import("@piarium/protocol").DocumentWriteGuardResult>;

/** Content-free fixed path lookup used by native Pi find/ls wrappers. */
export type HarnessDocumentPathOverlay = (
  sessionId: string,
  context: AgentInputContext,
  resourceId: string,
) => SurfaceSnapshotOverlayResult;

export interface HarnessServiceHost {
  outputStore: OutputStore;
  observationCursors: ObservationCursorStore;
  pathLockService: PathLockService;
  searchService: HarnessSearchService;
  exploreQueryStore: ExploreQueryStore;
  diagnosticsProvider: DiagnosticsProvider | null;
  lspNavigationServices: ReturnType<typeof createLspNavigationServices> | null;
  structureSource: StructureSource | null;
  /**
   * Graph relations for one path. `stale` is decided by the caller, which knows
   * the excerpt revision, so the provider does not report it. Throwing means
   * "not answered" and must degrade the annotation, not the search (D-112).
   */
  fileRelations: ((workspaceId: string, path: string) => Promise<Omit<import("@piarium/protocol").ExploreFileRelation, "stale"> | null>) | null;
  /**
   * Already-open symbol graph for path-level recall. Returning null means the
   * store is not open; the caller must degrade, not open a database (D-112).
   */
  graphRecall: ((workspaceId: string) => import("../knowledge/store.js").KnowledgeStore | null) | null;
  semanticRecall: ((
    workspaceId: string,
    question: string,
    limit: number,
    options?: {
      signal?: AbortSignal;
      roots?: readonly string[];
      sessionId?: string;
      inputContext?: import("@piarium/protocol").AgentInputContext;
    },
  ) => Promise<import("./explore.js").ExploreSemanticSearch>) | null;
  harnessSettings?: (
    workspaceId: string,
  ) => import("@piarium/protocol").PiSettingsSnapshot | null | Promise<import("@piarium/protocol").PiSettingsSnapshot | null>;
  rerankExploreViews?: (input: {
    workspaceId: string;
    query: string;
    documents: Array<{ id: string; text: string; revision?: string }>;
    settings: import("@piarium/protocol").HarnessRerankSettings;
    signal?: AbortSignal;
  }) => Promise<import("@piarium/protocol").HarnessRerankResult>;
  webFetchService: { fetch: (url: string, ctx: { workspaceId: string; render?: boolean }) => Promise<import("@piarium/protocol").FetchResult> } | null;
  webSearchService: import("./router.js").HarnessService<"web.search"> | null;
  documentReadSource: HarnessDocumentReadSource | null;
  documentPathOverlay: HarnessDocumentPathOverlay | null;
  documentWriteGuard: HarnessDocumentWriteGuard | null;
  // Phase 2: knowledge, memory, zone2, compaction, todo, recall
  knowledgeStore: KnowledgeStore | null;
  userKnowledgeStore: KnowledgeStore | null;
  memoryDepsProvider: ((sessionId: string) => Promise<{ store: KnowledgeStore; settings: MemoryAgentSettings }>) | null;
  zone2Provider: ((request: Zone2MaterialRequest) => Promise<Zone2MaterialResult>) | null;
  onSessionCompacted: ((sessionId: string) => void) | null;
  compactionDepsProvider: ((sessionId: string) => Promise<CompactionHandlerDeps>) | null;
  compactionSettings: CompactionSettings;
  keeperCoverageStore: KeeperCoverageStore;
  todoSettings: TodoToolSettings;
  recallDepsProvider: ((sessionId: string, workspaceId: string | null) => Promise<RecallToolDeps>) | null;
  todoDepsProvider: ((sessionId: string) => Promise<TodoToolDeps>) | null;
  // Phase 3: Thread registry
  threadRegistry: ThreadRegistry | null;
  threadCaptureDraftBaseline: ((sessionId: string, workspaceId: string, context: import("@piarium/protocol").AgentInputContext) => Promise<CapturedThreadDraftBaseline>) | null;
  threadSpawnSession: ((input: import("./thread-registry.js").CreateThreadInput & { threadId: string; runId: string }) => Promise<{ sessionId: string }>) | null;
  threadKillSession: ((threadId: string, keepWorktree?: boolean) => Promise<void>) | null;
  requireThreadMergeJournal: boolean;
  threadApplyWorktreeDiff: ((workspaceId: string, parent: import("@piarium/protocol").ThreadParent, threadId: string, resultRevision?: number, executionId?: string) => Promise<{
    merged: number;
    conflicts: string[];
    conflictState?: "none" | "markers" | "parent-unchanged";
    changedFiles?: string[];
    diffStats?: import("@piarium/protocol").ThreadDiffStats;
    appliedPaths?: string[];
    surfaceTargetPaths?: string[];
    status?: "applied" | "conflict" | "compensated" | "needs-attention";
    operationId?: string;
    resultRevision?: number;
  }>) | null;
  threadSendToSession: ((sessionId: string, message: string, from: "user" | "parent-agent") => Promise<void>) | null;
  threadTranscriptReader: ThreadTranscriptReader | null;
  registerSession(ctx: HarnessSessionContext): void;
  dropSession(sessionId: string, actor?: HarnessActorIdentity): void;
  hasActor(identity: HarnessActorIdentity): boolean;
  resolveActor(identity: HarnessActorIdentity): Promise<HarnessActorContext | null>;
  getShellSupervisor(sessionId: string): ShellSupervisor | null;
  getInterpreter(sessionId: string): ShellInterpreter | { unavailable: { reason: string; hint: string } } | null;
  resolveWorkspaceRoot?(workspaceId: string): Promise<string | null>;
  readExploreFile?: ExploreFileReader;
  /** Dirty paths this turn's fixed source still owns (D-088). */
  agentInputDraftPaths?: (sessionId: string, context: import("@piarium/protocol").AgentInputContext) => readonly string[];
  commitAgentInputContext: (sessionId: string, context: import("@piarium/protocol").AgentInputContext) => { committed: boolean };
  releaseAgentInputContext: (sessionId: string, context: import("@piarium/protocol").AgentInputContext) => { released: boolean };
  dispose(): Promise<void>;
}

export interface HarnessServiceHostOptions {
  search: HarnessSearchDeps["search"];
  resolveWorkspaceRoot: (workspaceId: string) => Promise<string | null>;
  readExploreFile?: ExploreFileReader;
  agentInputDraftPaths?: HarnessServiceHost["agentInputDraftPaths"];
  commitAgentInputContext?: HarnessServiceHost["commitAgentInputContext"];
  releaseAgentInputContext?: HarnessServiceHost["releaseAgentInputContext"];
  dropAgentInputContexts?: (sessionId: string) => void;
  diagnosticsProvider?: DiagnosticsProvider;
  lspNavigationServices?: ReturnType<typeof createLspNavigationServices>;
  structureSource?: StructureSource;
  fileRelations?: HarnessServiceHost["fileRelations"];
  graphRecall?: HarnessServiceHost["graphRecall"];
  semanticRecall?: HarnessServiceHost["semanticRecall"];
  harnessSettings?: HarnessServiceHost["harnessSettings"];
  rerankExploreViews?: HarnessServiceHost["rerankExploreViews"];
  shellSetting?: HarnessShellSetting;
  /**
   * Machine-level discovery. Production passes the Host construction result.
   * When omitted, the Host discovers once from the real environment so a
   * forgotten option cannot collapse Windows to "Git for Windows not found".
   */
  discoveredShells?: { gitBashPath?: string; wslDistros?: string[]; hasBash?: boolean; hasPowerShell?: boolean };
  discoverShells?: () => { gitBashPath?: string; wslDistros?: string[]; hasBash?: boolean; hasPowerShell?: boolean };
  /** Per-workspace fallback when the session context does not carry a setting. */
  resolveShellSetting?: (workspaceId: string | null) => HarnessShellSetting;
  remote?: boolean;
  /**
   * Called when a session's shell supervisor is created to register a
   * process-mode writer with the document authority. Returns a handle
   * with a close() method, or null if registration is not available.
   */
  registerWriter?: (sessionId: string, workspaceRoot: string) => Promise<{ close: () => Promise<void> } | null>;
  /** Web fetch service (null on cloud/web hosts without fetch capability) */
  webFetchService?: HarnessServiceHost["webFetchService"];
  /** Web search service (null when no search provider available) */
  webSearchService?: HarnessServiceHost["webSearchService"];
  /** Surface-aware native Pi read source (null when Documents is unavailable). */
  documentReadSource?: HarnessDocumentReadSource;
  /** Surface-aware native Pi find/ls path overlay (null when unavailable). */
  documentPathOverlay?: HarnessDocumentPathOverlay;
  /** Write admission against this turn's fixed draft (null when unavailable). */
  documentWriteGuard?: HarnessDocumentWriteGuard;
  // Phase 2 options
  knowledgeStore?: KnowledgeStore;
  userKnowledgeStore?: KnowledgeStore;
  memoryDepsProvider?: (sessionId: string) => Promise<{ store: KnowledgeStore; settings: MemoryAgentSettings }>;
  zone2Provider?: (request: Zone2MaterialRequest) => Promise<Zone2MaterialResult>;
  onSessionCompacted?: (sessionId: string) => void;
  compactionDepsProvider?: (sessionId: string) => Promise<CompactionHandlerDeps>;
  compactionSettings?: CompactionSettings;
  /** External keeper coverage store; if omitted, the host creates one. */
  keeperCoverageStore?: KeeperCoverageStore;
  todoSettings?: TodoToolSettings;
  recallDepsProvider?: (sessionId: string, workspaceId: string | null) => Promise<RecallToolDeps>;
  todoDepsProvider?: (sessionId: string) => Promise<TodoToolDeps>;
  // Phase 3 options
  threadRegistry?: ThreadRegistry;
  threadCaptureDraftBaseline?: HarnessServiceHost["threadCaptureDraftBaseline"];
  threadSpawnSession?: (input: import("./thread-registry.js").CreateThreadInput & { threadId: string; runId: string }) => Promise<{ sessionId: string }>;
  threadKillSession?: (threadId: string, keepWorktree?: boolean) => Promise<void>;
  threadApplyWorktreeDiff?: HarnessServiceHost["threadApplyWorktreeDiff"];
  requireThreadMergeJournal?: boolean;
  threadSendToSession?: (sessionId: string, message: string, from: "user" | "parent-agent") => Promise<void>;
  threadTranscriptReader?: ThreadTranscriptReader;
}

export function createHarnessServiceHost(options: HarnessServiceHostOptions): HarnessServiceHost {
  const outputStore = createOutputStore();
  const observationCursors = createObservationCursorStore();
  const pathLockService = createPathLockService();
  const exploreQueryStore = createExploreQueryStore();
  const searchService = createHarnessSearchService({
    search: options.search,
    resolveWorkspaceRoot: options.resolveWorkspaceRoot,
    ...(options.readExploreFile ? { readFile: options.readExploreFile } : {}),
    ...(options.agentInputDraftPaths ? { draftPaths: options.agentInputDraftPaths } : {}),
  });
  const diagnosticsProvider = options.diagnosticsProvider ?? null;
  const lspNavigationServices = options.lspNavigationServices ?? null;
  const structureSource = options.structureSource ?? null;
  const fileRelations = options.fileRelations ?? null;
  const graphRecall = options.graphRecall ?? null;
  const semanticRecall = options.semanticRecall ?? null;
  const harnessSettings = options.harnessSettings;
  const rerankExploreViews = options.rerankExploreViews;
  const webFetchService = options.webFetchService ?? null;
  const webSearchService = options.webSearchService ?? null;
  const documentReadSource = options.documentReadSource ?? null;
  const documentPathOverlay = options.documentPathOverlay ?? null;
  const documentWriteGuard = options.documentWriteGuard ?? null;
  // Phase 2
  const knowledgeStore = options.knowledgeStore ?? null;
  const userKnowledgeStore = options.userKnowledgeStore ?? null;
  const memoryDepsProvider = options.memoryDepsProvider ?? null;
  const zone2Provider = options.zone2Provider ?? null;
  const onSessionCompacted = options.onSessionCompacted ?? null;
  const compactionDepsProvider = options.compactionDepsProvider ?? null;
  const compactionSettings = options.compactionSettings ?? { keepTurns: 8, reinjectFileLimit: 5, reinjectFileTokens: 5000, reinjectTotalTokens: 50000, reinjectSkillsTokens: 25000 };
  const keeperCoverageStore = options.keeperCoverageStore ?? createKeeperCoverageStore();
  const todoSettings = options.todoSettings ?? { confirmBelow: 0.6 };
  const recallDepsProvider = options.recallDepsProvider ?? null;
  const todoDepsProvider = options.todoDepsProvider ?? null;
  // Phase 3
  const threadRegistry = options.threadRegistry ?? null;
  const threadCaptureDraftBaseline = options.threadCaptureDraftBaseline ?? null;
  const threadSpawnSession = options.threadSpawnSession ?? null;
  const threadKillSession = options.threadKillSession ?? null;
  const threadApplyWorktreeDiff = options.threadApplyWorktreeDiff ?? null;
  const threadSendToSession = options.threadSendToSession ?? null;
  const threadTranscriptReader = options.threadTranscriptReader ?? null;
  const commitAgentInputContext = options.commitAgentInputContext ?? ((_sessionId, context) => ({
    // A Host without a snapshot authority may acknowledge disk/unavailable
    // sources, but it must not claim an opaque ready snapshot was committed.
    committed: context.source === "disk" || context.snapshot.status === "unavailable",
  }));
  const releaseAgentInputContext = options.releaseAgentInputContext ?? (() => ({ released: false }));

  const sessions = new Map<string, SessionEntry>();
  const discoveredShells = options.discoveredShells
    ?? (options.discoverShells ?? discoverShells)();

  const registerSession = (ctx: HarnessSessionContext): void => {
    const sessionId = ctx.actor.sessionId;
    const previous = sessions.get(sessionId);
    if (previous) {
      void previous.shellSupervisor?.dispose();
      observationCursors.clearKind(sessionId, "shell");
      options.dropAgentInputContexts?.(sessionId);
      exploreQueryStore.dropSession(sessionId);
    }
    const interpreterResult = ctx.shellResolution
      ? { unavailable: ctx.shellResolution.invalid }
      : selectInterpreter({
        platform: process.platform,
        workspaceRoot: ctx.workspaceRoot,
        setting: ctx.shellSetting
          ?? options.resolveShellSetting?.(ctx.workspaceId)
          ?? options.shellSetting
          ?? "auto",
        discovered: discoveredShells,
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
    exploreQueryStore.dropSession(sessionId);
    observationCursors.clearObserver(sessionId);
    threadRegistry?.clearCursorsForSession(sessionId);
    pathLockService.dropSession(sessionId);
    keeperCoverageStore.clear(sessionId);
    options.dropAgentInputContexts?.(sessionId);
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
    exploreQueryStore.dispose();
    outputStore.dispose();
    observationCursors.dispose();
    pathLockService.dispose();
    if (knowledgeStore) disposes.push(knowledgeStore.close());
    if (userKnowledgeStore) disposes.push(userKnowledgeStore.close());
    await Promise.all(disposes);
  };

  return {
    outputStore,
    exploreQueryStore,
    observationCursors,
    pathLockService,
    searchService,
    diagnosticsProvider,
    lspNavigationServices,
    structureSource,
    fileRelations,
    graphRecall,
    semanticRecall,
    ...(harnessSettings ? { harnessSettings } : {}),
    ...(rerankExploreViews ? { rerankExploreViews } : {}),
    webFetchService,
    webSearchService,
    documentReadSource,
    documentPathOverlay,
    documentWriteGuard,
    knowledgeStore,
    userKnowledgeStore,
    memoryDepsProvider,
    zone2Provider,
    onSessionCompacted,
    compactionDepsProvider,
    compactionSettings,
    keeperCoverageStore,
    todoSettings,
    recallDepsProvider,
    todoDepsProvider,
    threadRegistry,
    threadCaptureDraftBaseline,
    threadSpawnSession,
    threadKillSession,
    threadApplyWorktreeDiff,
    requireThreadMergeJournal: options.requireThreadMergeJournal ?? false,
    threadSendToSession,
    threadTranscriptReader,
    commitAgentInputContext,
    releaseAgentInputContext,
    registerSession,
    dropSession,
    hasActor,
    resolveActor,
    getShellSupervisor,
    getInterpreter,
    resolveWorkspaceRoot: options.resolveWorkspaceRoot,
    dispose,
    ...(options.readExploreFile ? { readExploreFile: options.readExploreFile } : {}),
    ...(options.agentInputDraftPaths ? { agentInputDraftPaths: options.agentInputDraftPaths } : {}),
  };
}
