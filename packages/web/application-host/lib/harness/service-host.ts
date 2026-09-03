import { createOutputStore, type OutputStore } from "./output-store.js";
import { createPathLockService, type PathLockService } from "./path-lock.js";
import { createShellSupervisor, selectInterpreter, type ShellInterpreter, type ShellSupervisor } from "./shell-supervisor.js";
import { createHarnessSearchService, type HarnessSearchService } from "./search-service.js";
import type { DiagnosticsProvider } from "./diagnostics-service.js";
import type { WorkspaceContentSearchResult } from "../search/content.js";
import type { KnowledgeStore } from "../knowledge/store.js";
import type { MemoryAgentRunner } from "./memory-agent.js";
import type { Zone2Material } from "./zone2.js";
import type { CompactionHandlerDeps, CompactionSettings } from "./compaction.js";
import type { TodoToolDeps, TodoToolSettings } from "./todo-tool.js";
import type { RecallToolDeps } from "./recall-tool.js";
import type { ThreadRegistry } from "./thread-registry.js";

export interface HarnessSessionContext {
  sessionId: string;
  workspaceId: string | null;
  workspaceRoot: string;
}

interface SessionEntry {
  shellSupervisor: ShellSupervisor | null;
  interpreter: ShellInterpreter | { unavailable: { reason: string; hint: string } };
  workspaceRoot: string;
}

export interface HarnessServiceHost {
  outputStore: OutputStore;
  pathLockService: PathLockService;
  searchService: HarnessSearchService;
  diagnosticsProvider: DiagnosticsProvider | null;
  webFetchService: { fetch: (url: string, ctx: { workspaceId: string; render?: boolean }) => Promise<import("@piarium/protocol").FetchResult> } | null;
  webReadService: import("./router.js").HarnessService<"web.read"> | null;
  webSearchService: import("./router.js").HarnessService<"web.search"> | null;
  // Phase 2: knowledge, memory, zone2, compaction, todo, recall
  knowledgeStore: KnowledgeStore | null;
  userKnowledgeStore: KnowledgeStore | null;
  memoryAgent: MemoryAgentRunner | null;
  zone2Provider: ((sessionId: string, sinceTurn: number) => Promise<Zone2Material>) | null;
  compactionDepsProvider: ((sessionId: string) => Promise<CompactionHandlerDeps>) | null;
  compactionSettings: CompactionSettings;
  todoSettings: TodoToolSettings;
  recallDepsProvider: ((sessionId: string) => Promise<RecallToolDeps>) | null;
  todoDepsProvider: ((sessionId: string) => Promise<TodoToolDeps>) | null;
  // Phase 3: Thread registry
  threadRegistry: ThreadRegistry | null;
  threadSpawnSession: ((input: import("./thread-registry.js").CreateThreadInput & { threadId: string }) => Promise<{ sessionId: string }>) | null;
  threadKillSession: ((threadId: string) => Promise<void>) | null;
  threadApplyWorktreeDiff: ((threadId: string) => Promise<{ merged: number; conflicts: string[] }>) | null;
  threadSendToSession: ((sessionId: string, message: string, from: "user" | "parent-agent") => Promise<void>) | null;
  registerSession(ctx: HarnessSessionContext): void;
  dropSession(sessionId: string): void;
  getShellSupervisor(sessionId: string): ShellSupervisor | null;
  getInterpreter(sessionId: string): ShellInterpreter | { unavailable: { reason: string; hint: string } } | null;
  dispose(): Promise<void>;
}

export interface HarnessServiceHostOptions {
  search: (request: { query: string; workspaceId: string; maxResults?: number }, options: { signal?: AbortSignal }) => Promise<WorkspaceContentSearchResult>;
  resolveWorkspaceRoot: (workspaceId: string) => Promise<string | null>;
  diagnosticsProvider?: DiagnosticsProvider;
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
  memoryAgent?: MemoryAgentRunner;
  zone2Provider?: (sessionId: string, sinceTurn: number) => Promise<Zone2Material>;
  compactionDepsProvider?: (sessionId: string) => Promise<CompactionHandlerDeps>;
  compactionSettings?: CompactionSettings;
  todoSettings?: TodoToolSettings;
  recallDepsProvider?: (sessionId: string) => Promise<RecallToolDeps>;
  todoDepsProvider?: (sessionId: string) => Promise<TodoToolDeps>;
  // Phase 3 options
  threadRegistry?: ThreadRegistry;
  threadSpawnSession?: (input: import("./thread-registry.js").CreateThreadInput & { threadId: string }) => Promise<{ sessionId: string }>;
  threadKillSession?: (threadId: string) => Promise<void>;
  threadApplyWorktreeDiff?: (threadId: string) => Promise<{ merged: number; conflicts: string[] }>;
  threadSendToSession?: (sessionId: string, message: string, from: "user" | "parent-agent") => Promise<void>;
}

export function createHarnessServiceHost(options: HarnessServiceHostOptions): HarnessServiceHost {
  const outputStore = createOutputStore();
  const pathLockService = createPathLockService();
  const searchService = createHarnessSearchService({
    search: options.search,
    resolveWorkspaceRoot: options.resolveWorkspaceRoot,
  });
  const diagnosticsProvider = options.diagnosticsProvider ?? null;
  const webFetchService = options.webFetchService ?? null;
  const webReadService = options.webReadService ?? null;
  const webSearchService = options.webSearchService ?? null;
  // Phase 2
  const knowledgeStore = options.knowledgeStore ?? null;
  const userKnowledgeStore = options.userKnowledgeStore ?? null;
  const memoryAgent = options.memoryAgent ?? null;
  const zone2Provider = options.zone2Provider ?? null;
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

  const sessions = new Map<string, SessionEntry>();

  const registerSession = (ctx: HarnessSessionContext): void => {
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
        sessionId: ctx.sessionId,
        cwd: ctx.workspaceRoot ?? undefined,
        ...(options.registerWriter ? {
          registerWriter: () => options.registerWriter!(ctx.sessionId, ctx.workspaceRoot),
        } : {}),
      });
    }

    sessions.set(ctx.sessionId, {
      shellSupervisor,
      interpreter: interpreterResult,
      workspaceRoot: ctx.workspaceRoot,
    });
  };

  const dropSession = (sessionId: string): void => {
    const entry = sessions.get(sessionId);
    if (entry) {
      void entry.shellSupervisor?.dispose();
      sessions.delete(sessionId);
    }
    outputStore.dropSession(sessionId);
    pathLockService.dropSession(sessionId);
  };

  const getShellSupervisor = (sessionId: string): ShellSupervisor | null => {
    return sessions.get(sessionId)?.shellSupervisor ?? null;
  };

  const getInterpreter = (sessionId: string): ShellInterpreter | { unavailable: { reason: string; hint: string } } | null => {
    return sessions.get(sessionId)?.interpreter ?? null;
  };

  const dispose = async (): Promise<void> => {
    const disposes: Promise<void>[] = [];
    for (const entry of sessions.values()) {
      if (entry.shellSupervisor) disposes.push(entry.shellSupervisor.dispose());
    }
    sessions.clear();
    await Promise.all(disposes);
    outputStore.dispose();
    pathLockService.dispose();
    memoryAgent?.dispose();
    if (knowledgeStore) disposes.push(knowledgeStore.close());
    if (userKnowledgeStore) disposes.push(userKnowledgeStore.close());
    await Promise.all(disposes);
  };

  return {
    outputStore,
    pathLockService,
    searchService,
    diagnosticsProvider,
    webFetchService,
    webReadService,
    webSearchService,
    knowledgeStore,
    userKnowledgeStore,
    memoryAgent,
    zone2Provider,
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
    registerSession,
    dropSession,
    getShellSupervisor,
    getInterpreter,
    dispose,
  };
}
