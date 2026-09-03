import { createOutputStore, type OutputStore } from "./output-store.js";
import { createPathLockService, type PathLockService } from "./path-lock.js";
import { createShellSupervisor, selectInterpreter, type ShellSupervisor, type ShellInterpreter } from "./shell-supervisor.js";
import { createHarnessSearchService, type HarnessSearchService } from "./search-service.js";
import type { DiagnosticsProvider } from "./diagnostics-service.js";
import type { WorkspaceContentSearchResult, WorkspaceSearchHit } from "../search/content.js";

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
  registerSession(ctx: HarnessSessionContext): void;
  dropSession(sessionId: string): void;
  getShellSupervisor(sessionId: string): ShellSupervisor | null;
  getInterpreter(sessionId: string): ShellInterpreter | { unavailable: { reason: string; hint: string } } | null;
  dispose(): void;
}

export interface HarnessServiceHostOptions {
  search: (request: { query: string; workspaceId: string; maxResults?: number }, options: { signal?: AbortSignal }) => Promise<WorkspaceContentSearchResult>;
  resolveWorkspaceRoot: (workspaceId: string) => Promise<string | null>;
  diagnosticsProvider?: DiagnosticsProvider;
  shellSetting?: "auto" | "git-bash" | "powershell" | "wsl";
  discoveredShells?: { gitBashPath?: string; wslDistros?: string[]; hasBash?: boolean; hasPowerShell?: boolean };
  remote?: boolean;
}

export function createHarnessServiceHost(options: HarnessServiceHostOptions): HarnessServiceHost {
  const outputStore = createOutputStore();
  const pathLockService = createPathLockService();
  const searchService = createHarnessSearchService({
    search: options.search,
    resolveWorkspaceRoot: options.resolveWorkspaceRoot,
  });
  const diagnosticsProvider = options.diagnosticsProvider ?? null;

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

  const dispose = (): void => {
    for (const entry of sessions.values()) {
      void entry.shellSupervisor?.dispose();
    }
    sessions.clear();
    outputStore.dispose();
    pathLockService.dispose();
  };

  return {
    outputStore,
    pathLockService,
    searchService,
    diagnosticsProvider,
    registerSession,
    dropSession,
    getShellSupervisor,
    getInterpreter,
    dispose,
  };
}
