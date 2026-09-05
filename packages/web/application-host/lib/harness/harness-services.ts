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
import { applyOps } from "./memory-agent.js";
import { prepareZone2Threads } from "./zone2-threads.js";
import { ThreadRegistryError } from "./thread-registry.js";
import { explore } from "./explore.js";

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
      const result = await supervisor.exec(params.command, {
        ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
        waitMs: params.waitMs ?? 60_000,
      });
      if (result.kind === "background") {
        host.observationCursors.set(ctx.sessionId, "shell", result.id, {
          offset: Buffer.byteLength(result.outputSoFar, "utf8"),
        });
      }
      return result;
    },
  };
}

export function createShellReadService(host: HarnessServiceHost): HarnessService<"shell.read"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      const supervisor = host.getShellSupervisor(ctx.sessionId);
      if (!supervisor) throw new Error("No shell supervisor for session");
      const randomAccess = params.id.startsWith("out_") || params.offset !== undefined || params.length !== undefined;
      if (randomAccess) return supervisor.read(params.id, params.offset, params.length);

      const pending = await host.observationCursors.prepare<{ offset: number }, Awaited<ReturnType<typeof supervisor.read>> & {
        observation: NonNullable<import("@piarium/protocol").ShellReadResult["observation"]>;
      }>(ctx.sessionId, "shell", params.id, async (previous) => {
        const result = await supervisor.read(params.id, previous?.value.offset ?? 0);
        const now = host.observationCursors.now();
        return {
          cursor: { offset: result.nextOffset },
          result: {
            ...result,
            observation: {
              mode: "incremental",
              first: previous === null,
              ...(previous === null ? {} : { sinceMs: Math.max(0, now - previous.observedAt) }),
              ...(result.lastOutputAt === undefined ? {} : { lastOutputAgoMs: Math.max(0, now - result.lastOutputAt) }),
            },
          },
        };
      });
      if (ctx.deferResponseDelivery) ctx.deferResponseDelivery(pending.commit, pending.abort);
      else pending.commit();
      return pending.result;
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
        return { content: null, eventCursor: params.afterEventId ?? 0 };
      }
      const result = await host.zone2Provider({
        sessionId: ctx.sessionId,
        sinceTurn: params.sinceTurn,
        ...(params.afterEventId === undefined ? {} : { afterEventId: params.afterEventId }),
        ...(params.query === undefined ? {} : { query: params.query }),
        ...(params.branchEntryIds === undefined ? {} : { branchEntryIds: params.branchEntryIds }),
        contextUsage: params.contextUsage ?? null,
      });
      let threads = null;
      if (host.threadRegistry && ctx.workspaceId) {
        try {
          const pendingThreads = await prepareZone2Threads({
            registry: host.threadRegistry,
            cursors: host.observationCursors,
          }, {
            sessionId: ctx.sessionId,
            workspaceId: ctx.workspaceId,
          });
          if (ctx.deferResponseDelivery) ctx.deferResponseDelivery(pendingThreads.commit, pendingThreads.abort);
          else pendingThreads.commit();
          threads = pendingThreads.result;
        } catch (error) {
          threads = {
            status: "unavailable" as const,
            reason: error instanceof ThreadRegistryError ? error.code : "failed",
          };
        }
      }
      const content = assembleZone2Content({ ...result.material, threads }, { eventCursor: result.eventCursor });
      return { content, eventCursor: result.eventCursor };
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
      // Merge the host's keeperCoverageStore into the deps. The provider
      // may not include it, but the host always has one (created by default
      // in createHarnessServiceHost). This ensures the mandatory coverage
      // check can run.
      const depsWithCoverage = {
        ...deps,
        ...(deps.coverageStore ? {} : { coverageStore: host.keeperCoverageStore }),
      };
      const result = await handleBeforeCompact(
        ctx.sessionId,
        depsWithCoverage,
        {
          firstKeptEntryId: params.firstKeptEntryId,
          tokensBefore: params.tokensBefore,
          branchEntryIds: params.branchEntryIds,
          removedEntryIds: params.removedEntryIds,
        },
      );
      return result;
    },
  };
}

export function createCompactionAfterService(host: HarnessServiceHost): HarnessService<"compaction.after"> {
  return {
    handle: async (_params, ctx: HarnessServiceContext) => {
      host.observationCursors.clearObserver(ctx.sessionId);
      host.threadRegistry?.clearCursorsForSession(ctx.sessionId);
      host.keeperCoverageStore.clear(ctx.sessionId);
      host.onSessionCompacted?.(ctx.sessionId);
      return { acknowledged: true };
    },
  };
}

export function createMemoryBlocksGetService(host: HarnessServiceHost): HarnessService<"memory.blocks.get"> {
  return {
    handle: async (params, ctx) => {
      if (!host.memoryDepsProvider) throw new HarnessServiceError("unavailable", "Memory block storage is unavailable");
      const deps = await host.memoryDepsProvider(ctx.sessionId);
      const blocks = await deps.store.getBlocks(
        ctx.sessionId,
        params.branchEntryIds,
      );
      return {
        blocks: blocks.map((block) => ({
          label: block.label,
          content: block.content,
          updatedBy: block.updatedBy,
          revision: block.updatedAt,
          ...(block.cursorTurn === undefined ? {} : { cursorTurn: block.cursorTurn }),
          ...(block.sourceLeafId === undefined ? {} : { sourceLeafId: block.sourceLeafId }),
        })),
      };
    },
  };
}

export function createMemoryBlocksApplyService(host: HarnessServiceHost): HarnessService<"memory.blocks.apply"> {
  return {
    handle: async (params, ctx) => {
      if (!host.memoryDepsProvider) throw new HarnessServiceError("unavailable", "Memory block storage is unavailable");
      const deps = await host.memoryDepsProvider(ctx.sessionId);
      // The source leaf is the last entry ID in the branch path — the
      // current leaf at apply time. Blocks written here will be visible
      // on this branch and its descendants via ancestor resolution.
      const sourceLeafId = params.branchEntryIds && params.branchEntryIds.length > 0
        ? params.branchEntryIds[params.branchEntryIds.length - 1]!
        : null;
      const branchSet = new Set(params.branchEntryIds);
      if (params.coveredEntryIds.some((entryId) => !branchSet.has(entryId))) {
        throw new HarnessServiceError("invalid-params", "Keeper coverage contains an entry outside the submitted branch");
      }
      const result = await applyOps(params.ops, deps.store, ctx.sessionId, params.cursorTurn, deps.settings, {
        branchEntryIds: params.branchEntryIds,
        sourceLeafId,
      });
      // Only a fully accepted, material block update can certify the context
      // entries used for that update. Partial patches and no-op/stale results
      // deliberately leave coverage unchanged so takeover falls back to Pi.
      if (result.rejected === 0 && result.changedBlocks && params.coveredEntryIds.length > 0) {
        host.keeperCoverageStore.extend(ctx.sessionId, params.coveredEntryIds);
      }
      return result;
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
        params.confirmed === true,
        params.branchEntryIds,
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
    router.register("lsp.diagnosticsSnapshot", createLspDiagnosticsSnapshotService(host.diagnosticsProvider, host.observationCursors));
  }
  if (host.lspNavigationServices) {
    router.register("lsp.symbols", host.lspNavigationServices.symbols);
    router.register("lsp.definition", host.lspNavigationServices.definition);
    router.register("lsp.references", host.lspNavigationServices.references);
    router.register("lsp.hover", host.lspNavigationServices.hover);
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
  // Every Host can acknowledge compaction and reset observer baselines even
  // when custom compaction takeover is unavailable.
  router.register("compaction.after", createCompactionAfterService(host));
  if (host.memoryDepsProvider) {
    router.register("memory.blocks.get", createMemoryBlocksGetService(host));
    router.register("memory.blocks.apply", createMemoryBlocksApplyService(host));
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
  router.register("explore.search", createExploreSearchService(host));
}

export function createExploreSearchService(host: HarnessServiceHost): HarnessService<"explore.search"> {
  return {
    handle: async (params, ctx) => {
      const workspaceId = ctx.workspaceId ?? "";
      const rgSearch = async (pattern: string, options: { fixedStrings: boolean; paths?: string[] | undefined; limit: number }) => {
        const res = await host.searchService.search({
          pattern,
          limit: options.limit,
          ...(options.paths && options.paths.length > 0 ? { path: options.paths[0] } : {}),
        }, {
          workspaceId,
          ...(ctx.workspaceScope ? { workspaceScope: ctx.workspaceScope } : {}),
          signal: ctx.signal,
        });
        if (res.status === "unavailable") {
          throw new HarnessServiceError("unavailable", "Search service is unavailable");
        }
        const matches: Array<{ path: string; line: number; text: string }> = [];
        if (res.status === "ready") {
          for (const file of res.files) {
            for (const hit of file.hits) {
              matches.push({
                path: file.path,
                line: hit.line,
                text: hit.text,
              });
            }
          }
        }
        return matches;
      };
      const searchSymbols = async () => [];
      const result = await explore({
        question: params.question,
        ...(params.paths ? { paths: params.paths } : {}),
        ...(params.limit ? { limit: params.limit } : {}),
      }, {
        rgSearch,
        searchSymbols,
      });

      const lines: string[] = [];
      lines.push(`Found ${result.snippets.length} snippet(s) for question "${params.question}":`);
      for (const s of result.snippets) {
        lines.push(`--- ${s.path}:${s.startLine}-${s.endLine} (${s.why}) ---`);
        lines.push(s.text);
      }

      const fullText = lines.join("\n");
      const stored = host.outputStore.store(ctx.sessionId, fullText, "explore");

      return {
        text: fullText,
        snippets: result.snippets,
        searched: result.searched,
        handle: stored.ref.handle,
      };
    },
  };
}

export type { HarnessServiceMap };
