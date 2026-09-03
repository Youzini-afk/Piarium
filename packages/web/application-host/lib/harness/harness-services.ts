import type { HarnessService, HarnessServiceContext } from "./router.js";
import type { HarnessError, HarnessServiceMap, ShellExecResultSpawnFailed } from "@piarium/protocol";

/**
 * Error thrown by harness services to produce a specific HarnessError code
 * in the router's catch block. The router checks for this class to extract
 * the code; other errors default to "failed".
 */
export class HarnessServiceError extends Error {
  readonly harnessCode: HarnessError["code"];
  readonly harnessRetryable: boolean;
  constructor(code: HarnessError["code"], message: string, retryable = false) {
    super(message);
    this.name = "HarnessServiceError";
    this.harnessCode = code;
    this.harnessRetryable = retryable;
  }
}
import type { OutputStore } from "./output-store.js";
import type { PathLockService } from "./path-lock.js";
import type { HarnessSearchService } from "./search-service.js";
import type { HarnessServiceHost } from "./service-host.js";
import { createLspDiagnosticsService, createLspDiagnosticsSnapshotService } from "./diagnostics-service.js";
import { assembleZone2Content } from "./zone2.js";
import { handleBeforeCompact } from "./compaction.js";
import { executeTodoTool } from "./todo-tool.js";
import { executeRecall } from "./recall-tool.js";

export function createShellExecService(host: HarnessServiceHost): HarnessService<"shell.exec"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      const supervisor = host.getShellSupervisor(ctx.sessionId);
      if (!supervisor) {
        const interpreter = host.getInterpreter(ctx.sessionId);
        const reason = interpreter && "unavailable" in interpreter ? interpreter.unavailable.reason : "no-session";
        const hint = interpreter && "unavailable" in interpreter ? interpreter.unavailable.hint : "Session not registered";
        return { kind: "spawn-failed", reason, interpreter: "", hint } as ShellExecResultSpawnFailed;
      }
      return supervisor.exec(params.command, {
        ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
        waitMs: params.waitMs ?? 60_000,
      });
    },
  };
}

export function createShellReadService(host: HarnessServiceHost): HarnessService<"shell.read"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      const supervisor = host.getShellSupervisor(ctx.sessionId);
      if (!supervisor) throw new Error("No shell supervisor for session");
      return supervisor.read(params.id, params.offset, params.length);
    },
  };
}

export function createShellWriteService(host: HarnessServiceHost): HarnessService<"shell.write"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      const supervisor = host.getShellSupervisor(ctx.sessionId);
      if (!supervisor) return { accepted: false };
      const accepted = await supervisor.write(params.id, params.text);
      return { accepted };
    },
  };
}

export function createShellKillService(host: HarnessServiceHost): HarnessService<"shell.kill"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      const supervisor = host.getShellSupervisor(ctx.sessionId);
      if (!supervisor) return { killed: false };
      const killed = await supervisor.kill(params.id);
      return { killed };
    },
  };
}

export function createOutputStoreService(store: OutputStore): HarnessService<"output.store"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      const result = store.store(ctx.sessionId, params.text, params.label);
      return { handle: result.handle, total: result.total };
    },
  };
}

export function createOutputReadService(store: OutputStore): HarnessService<"output.read"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      const slice = store.read(ctx.sessionId, params.handle, params.offset, params.length);
      if (!slice) {
        throw new HarnessServiceError("not-found", `Output handle not found: ${params.handle}`);
      }
      return slice;
    },
  };
}

export function createSearchContentService(search: HarnessSearchService): HarnessService<"search.content"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      return search.search(params, ctx);
    },
  };
}

export function createFsLockService(locks: PathLockService): HarnessService<"fs.lock"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      if (params.action === "acquire") {
        const held = await locks.acquire(ctx.sessionId, params.path, params.timeoutMs);
        return { held };
      }
      if (params.action === "release") {
        const released = locks.release(ctx.sessionId, params.path);
        return { held: !released };
      }
      throw new Error(`Unknown fs.lock action: ${params.action}`);
    },
  };
}

// ── Phase 2 service factories ──────────────────────────────────────

export function createZone2AssembleService(host: HarnessServiceHost): HarnessService<"zone2.assemble"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      if (!host.zone2Provider) {
        return { content: null };
      }
      const material = await host.zone2Provider(ctx.sessionId, params.sinceTurn);
      const content = assembleZone2Content(material);
      return { content };
    },
  };
}

export function createCompactionBeforeService(host: HarnessServiceHost): HarnessService<"compaction.before"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      if (!host.compactionDepsProvider) {
        // Fallback: no custom compaction — return the raw params so Pi
        // proceeds with its own LLM summarization (hook result is ignored
        // when compaction field is absent).
        throw new HarnessServiceError("unavailable", "Compaction deps not configured");
      }
      const deps = await host.compactionDepsProvider(ctx.sessionId);
      const result = await handleBeforeCompact(ctx.sessionId, deps);
      return result;
    },
  };
}

export function createCompactionAfterService(host: HarnessServiceHost): HarnessService<"compaction.after"> {
  return {
    handle: async (_params, _ctx: HarnessServiceContext) => {
      // Notify memory agent to do a pre-compaction refresh if needed.
      // The actual compaction has already happened; this is a post-hook.
      if (host.memoryAgent) {
        await host.memoryAgent.requestPreCompactionRefresh();
      }
      return { acknowledged: true };
    },
  };
}

export function createTodoUpsertService(host: HarnessServiceHost): HarnessService<"todo.upsert"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      if (!host.todoDepsProvider) {
        throw new HarnessServiceError("unavailable", "Todo deps not configured");
      }
      const deps = await host.todoDepsProvider(ctx.sessionId);
      const result = await executeTodoTool(
        { items: params.items, ...(params.confidence !== undefined ? { confidence: params.confidence } : {}) },
        deps,
        false, // sessionConfirmed — TODO: track per-session confirmation state
      );
      return {
        text: result.text,
        ...(result.confirmed !== undefined ? { confirmed: result.confirmed } : {}),
        askedConfirmation: result.askedConfirmation,
      };
    },
  };
}

export function createRecallSearchService(host: HarnessServiceHost): HarnessService<"recall.search"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      if (!host.recallDepsProvider) {
        throw new HarnessServiceError("unavailable", "Recall deps not configured");
      }
      const deps = await host.recallDepsProvider(ctx.sessionId);
      const k = params.k ?? 5;
      const result = await executeRecall(params.query, k, deps);
      return {
        text: result.text,
        results: result.results.map((r) => {
          const payload = r.node.payload as Record<string, unknown>;
          const scope = (payload["scope"] as string) ?? "workspace";
          const content = (payload["content"] as string) ?? "";
          const title = content.split("\n")[0] ?? content;
          return { scope, title, via: r.via, id: r.node.id };
        }),
      };
    },
  };
}

// ── Phase 3 thread service factories ───────────────────────────────

export function createThreadDispatchService(host: HarnessServiceHost): HarnessService<"thread.dispatch"> {
  return {
    handle: async (params, _ctx: HarnessServiceContext) => {
      if (!host.threadRegistry || !host.threadSpawnSession) {
        throw new HarnessServiceError("unavailable", "Thread registry not configured");
      }
      const record = await host.threadRegistry.createThread({
        parentSessionId: params.parentSessionId,
        brief: params.task,
        role: params.role,
        kind: "implementation",
        createdBy: "agent",
        autoRun: true,
        worktree: "isolated",
        tools: [],
        permissions: {},
        ...(params.scope ? { scope: params.scope } : {}),
      });
      // Spawn the child session
      const { sessionId } = await host.threadSpawnSession({
        parentSessionId: params.parentSessionId,
        brief: params.task,
        role: params.role,
        kind: "implementation",
        createdBy: "agent",
        autoRun: true,
        worktree: "isolated",
        tools: [],
        permissions: {},
        threadId: record.id,
        ...(params.scope ? { scope: params.scope } : {}),
      });
      await host.threadRegistry.setSessionId(params.parentSessionId, record.id, sessionId);
      return {
        text: `dispatched ${record.id} (${params.role})`,
        threadId: record.id,
      };
    },
  };
}

export function createThreadListService(host: HarnessServiceHost): HarnessService<"thread.list"> {
  return {
    handle: async (params, _ctx: HarnessServiceContext) => {
      if (!host.threadRegistry) {
        throw new HarnessServiceError("unavailable", "Thread registry not configured");
      }
      const threads = await host.threadRegistry.listThreads(params.parentSessionId);
      return {
        threads: threads.map((t) => ({
          id: t.id,
          status: t.status,
          brief: t.brief,
          role: t.role,
          steps: t.steps,
          lastActivityAt: t.lastActivityAt,
          flags: t.flags,
          waitingFor: t.waitingFor,
        })),
      };
    },
  };
}

export function createThreadWaitService(host: HarnessServiceHost): HarnessService<"thread.wait"> {
  return {
    handle: async (params, _ctx: HarnessServiceContext) => {
      if (!host.threadRegistry) {
        throw new HarnessServiceError("unavailable", "Thread registry not configured");
      }
      const allThreads = await host.threadRegistry.listThreads(params.parentSessionId, true);
      const targetIds = params.ids ?? allThreads.map((t) => t.id);
      const done = allThreads.filter((t) => targetIds.includes(t.id) && (t.status === "done" || t.status === "failed" || t.status === "cancelled" || t.status === "merged"));
      const running = allThreads.filter((t) => targetIds.includes(t.id) && t.status === "running");
      const queued = allThreads.filter((t) => targetIds.includes(t.id) && t.status === "queued");
      // Format result similar to worker-runtime's formatWaitResult
      const lines: string[] = [];
      lines.push(`${done.length} done · ${running.length} running · ${queued.length} queued`);
      for (const t of done) {
        const conclusion = t.report?.conclusion.split("\n")[0] ?? "completed";
        const files = t.report?.changedFiles.length ?? 0;
        const confidence = t.report?.confidence ?? 0;
        lines.push(`\u2714 ${t.id} (${t.role ?? "unknown"}) \u2014 ${conclusion} \u00b7 files: ${files} \u00b7 confidence ${confidence}`);
      }
      for (const t of running) {
        lines.push(`\u2026 ${t.id} (${t.role ?? "unknown"}) \u00b7 ${t.steps} steps`);
      }
      for (const t of queued) {
        lines.push(`\u23f3 ${t.id} (${t.role ?? "unknown"}) \u00b7 queued`);
      }
      return {
        text: lines.join("\n"),
        done: done.length,
        running: running.length,
        queued: queued.length,
      };
    },
  };
}

export function createThreadSendService(host: HarnessServiceHost): HarnessService<"thread.send"> {
  return {
    handle: async (params, _ctx: HarnessServiceContext) => {
      if (!host.threadRegistry || !host.threadSendToSession) {
        throw new HarnessServiceError("unavailable", "Thread registry not configured");
      }
      const thread = await host.threadRegistry.getThread(params.parentSessionId, params.threadId);
      if (!thread) {
        throw new HarnessServiceError("not-found", `Thread not found: ${params.threadId}`);
      }
      await host.threadSendToSession(thread.sessionId, params.message, params.from);
      return { accepted: true };
    },
  };
}

export function createThreadReadService(host: HarnessServiceHost): HarnessService<"thread.read"> {
  return {
    handle: async (params, _ctx: HarnessServiceContext) => {
      if (!host.threadRegistry) {
        throw new HarnessServiceError("unavailable", "Thread registry not configured");
      }
      const thread = await host.threadRegistry.getThread(params.parentSessionId, params.threadId);
      if (!thread) {
        throw new HarnessServiceError("not-found", `Thread not found: ${params.threadId}`);
      }
      const lines: string[] = [];
      lines.push(`Thread ${thread.id} (${thread.role ?? "unknown"}) \u2014 ${thread.status}`);
      lines.push(`Brief: ${thread.brief}`);
      lines.push(`Steps: ${thread.steps} \u00b7 Last activity: ${thread.lastActivityAt}`);
      if (thread.report) {
        lines.push("");
        lines.push("Report:");
        lines.push(`  Conclusion: ${thread.report.conclusion}`);
        lines.push(`  Changed files: ${thread.report.changedFiles.join(", ") || "(none)"}`);
        lines.push(`  Unresolved: ${thread.report.unresolved.join(", ") || "(none)"}`);
        lines.push(`  Confidence: ${thread.report.confidence}`);
      }
      return {
        text: lines.join("\n"),
        report: thread.report,
      };
    },
  };
}

export function createThreadMergeService(host: HarnessServiceHost): HarnessService<"thread.merge"> {
  return {
    handle: async (params, _ctx: HarnessServiceContext) => {
      if (!host.threadRegistry || !host.threadApplyWorktreeDiff) {
        throw new HarnessServiceError("unavailable", "Thread registry not configured");
      }
      const thread = await host.threadRegistry.getThread(params.parentSessionId, params.threadId);
      if (!thread) {
        throw new HarnessServiceError("not-found", `Thread not found: ${params.threadId}`);
      }
      if (thread.status !== "done") {
        return {
          text: `thread ${params.threadId} is not done (status: ${thread.status})`,
          merged: 0,
          conflicts: [],
        };
      }
      const result = await host.threadApplyWorktreeDiff(params.threadId);
      if (result.conflicts.length > 0) {
        return {
          text: `merge has conflicts in ${result.conflicts.length} files (markers left in place):\n${result.conflicts.join("\n")}\nResolve them with edit; no further merge step is needed.`,
          merged: 0,
          conflicts: result.conflicts,
        };
      }
      await host.threadRegistry.mergeThread(params.parentSessionId, params.threadId);
      return {
        text: `merged ${result.merged} files`,
        merged: result.merged,
        conflicts: [],
      };
    },
  };
}

export function createThreadKillService(host: HarnessServiceHost): HarnessService<"thread.kill"> {
  return {
    handle: async (params, _ctx: HarnessServiceContext) => {
      if (!host.threadRegistry) {
        throw new HarnessServiceError("unavailable", "Thread registry not configured");
      }
      const thread = await host.threadRegistry.getThread(params.parentSessionId, params.threadId);
      if (!thread) {
        return { text: `unknown thread: ${params.threadId}` };
      }
      if (thread.status === "queued") {
        await host.threadRegistry.cancelThread(params.parentSessionId, params.threadId, "killed by parent");
        return { text: `killed ${params.threadId} (was queued)` };
      }
      if (host.threadKillSession) {
        await host.threadKillSession(params.threadId);
      }
      await host.threadRegistry.cancelThread(params.parentSessionId, params.threadId, "killed by parent");
      return { text: `killed ${params.threadId}` };
    },
  };
}

export function registerHarnessServices(
  router: { register: <M extends keyof HarnessServiceMap>(method: M, service: HarnessService<M>) => void },
  host: HarnessServiceHost,
): void {
  router.register("shell.exec", createShellExecService(host));
  router.register("shell.read", createShellReadService(host));
  router.register("shell.write", createShellWriteService(host));
  router.register("shell.kill", createShellKillService(host));
  router.register("output.store", createOutputStoreService(host.outputStore));
  router.register("output.read", createOutputReadService(host.outputStore));
  router.register("search.content", createSearchContentService(host.searchService));
  router.register("fs.lock", createFsLockService(host.pathLockService));
  if (host.diagnosticsProvider) {
    router.register("lsp.diagnostics", createLspDiagnosticsService(host.diagnosticsProvider));
    router.register("lsp.diagnosticsSnapshot", createLspDiagnosticsSnapshotService(host.diagnosticsProvider));
  }
  // Web services — registered only when available
  if (host.webFetchService) {
    router.register("web.fetch", {
      handle: async (params, ctx) => {
        if (!ctx.workspaceId) {
          return { status: "failed", url: params.url, reason: "no workspace" };
        }
        return host.webFetchService!.fetch(params.url, {
          workspaceId: ctx.workspaceId,
          ...(params.render !== undefined ? { render: params.render } : {}),
        });
      },
    });
  }
  if (host.webReadService) {
    router.register("web.read", host.webReadService);
  }
  if (host.webSearchService) {
    router.register("web.search", host.webSearchService);
  }
  // Phase 2 services — registered only when the corresponding provider is available
  if (host.zone2Provider) {
    router.register("zone2.assemble", createZone2AssembleService(host));
  }
  if (host.compactionDepsProvider) {
    router.register("compaction.before", createCompactionBeforeService(host));
  }
  if (host.memoryAgent || host.compactionDepsProvider) {
    router.register("compaction.after", createCompactionAfterService(host));
  }
  if (host.todoDepsProvider) {
    router.register("todo.upsert", createTodoUpsertService(host));
  }
  if (host.recallDepsProvider) {
    router.register("recall.search", createRecallSearchService(host));
  }
  // Phase 3 thread services — registered only when thread registry is available
  if (host.threadRegistry && host.threadSpawnSession) {
    router.register("thread.dispatch", createThreadDispatchService(host));
  }
  if (host.threadRegistry) {
    router.register("thread.list", createThreadListService(host));
    router.register("thread.wait", createThreadWaitService(host));
    router.register("thread.read", createThreadReadService(host));
    router.register("thread.kill", createThreadKillService(host));
  }
  if (host.threadRegistry && host.threadSendToSession) {
    router.register("thread.send", createThreadSendService(host));
  }
  if (host.threadRegistry && host.threadApplyWorktreeDiff) {
    router.register("thread.merge", createThreadMergeService(host));
  }
}

export type { HarnessServiceMap };
