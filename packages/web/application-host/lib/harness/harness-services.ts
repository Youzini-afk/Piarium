import type { HarnessService, HarnessServiceContext } from "./router.js";
import type { HarnessServiceMap, ShellExecResultSpawnFailed } from "@piarium/protocol";
import { HarnessServiceError } from "./service-error.js";
import {
  createThreadDispatchService,
  createThreadKillService,
  createThreadListService,
  createThreadMergeService,
  createThreadReadService,
  createThreadSendService,
  createThreadWaitService,
} from "./thread-services.js";

import type { OutputStore } from "./output-store.js";
import { DEFAULT_PATH_LOCK_TIMEOUT_MS, type PathLockService } from "./path-lock.js";
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
      return { ref: result.ref, total: result.total };
    },
  };
}

export function createOutputReadService(store: OutputStore): HarnessService<"output.read"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      const slice = store.read(ctx.sessionId, params.handle, params.offset, params.length);
      if (slice.status === "expired") {
        throw new HarnessServiceError("expired", `Output handle expired: ${params.handle}`);
      }
      if (slice.status === "not-found") {
        throw new HarnessServiceError("not-found", `Output handle not found: ${params.handle}`);
      }
      return slice.slice;
    },
  };
}

export function createSearchContentService(search: HarnessSearchService): HarnessService<"search.content"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      return search.search(params, {
        signal: ctx.signal,
        workspaceId: ctx.workspaceId,
        ...(ctx.actor.workspaceScope ? { workspaceScope: ctx.actor.workspaceScope } : {}),
      });
    },
  };
}

export function createFsLockService(locks: PathLockService): HarnessService<"fs.lock"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      if (params.action === "acquire") {
        const resources = [...new Map(ctx.authorizedPaths.map((path) => [
          `${path.authorityId}\0${path.workspaceId}\0${path.canonicalResourceId}`,
          path,
        ])).values()].toSorted((left, right) => (
          left.authorityId.localeCompare(right.authorityId)
          || left.workspaceId.localeCompare(right.workspaceId)
          || left.canonicalResourceId.localeCompare(right.canonicalResourceId)
        ));
        const leaseIds: string[] = [];
        const deadline = Date.now() + (params.timeoutMs ?? DEFAULT_PATH_LOCK_TIMEOUT_MS);
        try {
          for (const resource of resources) {
            const remainingMs = Math.max(1, deadline - Date.now());
            leaseIds.push(await locks.acquire(ctx.sessionId, resource, remainingMs));
          }
          return { held: true, leaseIds };
        } catch (error) {
          for (let index = leaseIds.length - 1; index >= 0; index -= 1) {
            locks.release(ctx.sessionId, leaseIds[index]!);
          }
          throw error;
        }
      }
      if (params.action === "release") {
        return { held: false, released: locks.release(ctx.sessionId, params.leaseId) };
      }
      throw new Error("Unknown fs.lock action");
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
        throw new HarnessServiceError("unavailable", "Compaction deps not configured");
      }
      const deps = await host.compactionDepsProvider(ctx.sessionId);
      // Use Pi's preparation directly — no broker round-trip for entry ID
      const result = await handleBeforeCompact(
        ctx.sessionId,
        deps,
        { firstKeptEntryId: params.firstKeptEntryId, tokensBefore: params.tokensBefore },
      );
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

// Thread service implementations live in thread-services.ts so the registry model stays isolated from the other Host services.

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
