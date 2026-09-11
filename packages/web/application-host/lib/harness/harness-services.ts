import type { HarnessService, HarnessServiceContext } from "./router.js";
import type { HarnessServiceMap, ShellExecResultSpawnFailed } from "@piarium/protocol";
import { encodeDocumentText } from "../documents/inspect.js";
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
import { proposeUserMessageSuggestion } from "./knowledge-suggestions.js";
import { applyOps } from "./memory-agent.js";
import { prepareZone2Threads } from "./zone2-threads.js";
import { ThreadRegistryError } from "./thread-registry.js";
import { createExploreSearchService } from "./explore-service.js";
import {
  createExploreQueryCancelService,
  createExploreQueryFinishService,
  createExploreQueryFollowupService,
  createExploreQueryPlanService,
  createExploreQueryReleaseService,
  createExploreQuerySelectService,
  createExploreQueryStartService,
  createExploreQueryViewsService,
} from "./explore-query-services.js";
import { createRelatedQueryService } from "./related-service.js";
import { compileFindGlob, normalizeGlobPath } from "./glob-matcher.js";
import { presentOrganizedOutput } from "./output-organize/present.js";
import { utf8Bytes } from "./output-organize/index.js";
export { createExploreSearchService } from "./explore-service.js";

export function createShellExecService(host: HarnessServiceHost): HarnessService<"shell.exec"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      const materializeError = await requireMaterializedDirectory(host, ctx.sessionId, ctx.signal);
      if (materializeError) {
        return {
          kind: "spawn-failed",
          reason: "working-branch-materialize",
          interpreter: "",
          hint: materializeError,
        } as ShellExecResultSpawnFailed;
      }
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
      if (result.kind === "completed") {
        const presented = presentOrganizedOutput({
          command: params.command,
          output: result.stdout,
          complete: true,
          exitCode: result.exitCode,
          existingHandle: result.handle,
          store: host.outputStore,
          sessionId: ctx.sessionId,
        });
        return {
          ...result,
          handle: presented.handle,
          display: presented.display,
          organized: presented.organized,
          shown: presented.organized.omitted
            ? { head: utf8Bytes(presented.display), tail: 0, total: utf8Bytes(result.stdout) }
            : result.shown,
        };
      }
      if (result.kind === "background") {
        const presented = presentOrganizedOutput({
          command: params.command,
          output: result.outputSoFar,
          complete: false,
        });
        host.observationCursors.set(ctx.sessionId, "shell", result.id, {
          offset: Buffer.byteLength(result.outputSoFar, "utf8"),
        });
        return {
          ...result,
          command: params.command,
          display: presented.display,
          organized: presented.organized,
        };
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
        display?: string;
        organized?: import("@piarium/protocol").ShellOutputOrganization;
        command?: string;
      }>(ctx.sessionId, "shell", params.id, async (previous) => {
        const result = await supervisor.read(params.id, previous?.value.offset ?? 0, Number.MAX_SAFE_INTEGER);
        const now = host.observationCursors.now();
        const presented = presentOrganizedOutput({
          command: result.command ?? "",
          output: result.text,
          // An incremental read is only the newly observed slice. Even after
          // the process exits, it may be the final fragment of a larger
          // transcript already consumed by an earlier read, so do not let
          // `running === false` turn this slice into a final summary.
          complete: false,
          ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        });
        return {
          cursor: { offset: result.nextOffset },
          result: {
            ...result,
            display: presented.display,
            organized: presented.organized,
            ...(result.command === undefined ? {} : { command: result.command }),
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
        actor: ctx.actor,
        ...(ctx.inputContext ? { inputContext: ctx.inputContext } : {}),
      });
    },
  };
}

/**
 * Resolve the source for one native Pi read. Path authorization is performed
 * by the router before this service runs; only the authorized resource ID is
 * passed to Documents so aliases cannot select a different snapshot entry.
 */
export function createDocumentReadSourceService(
  host: Pick<HarnessServiceHost, "documentReadSource">,
): HarnessService<"document.readSource"> {
  return {
    handle: async (_params, ctx) => {
      const authorized = ctx.authorizedPaths[0];
      if (!host.documentReadSource || !authorized || ctx.authorizedPaths.length !== 1) {
        throw new HarnessServiceError("unavailable", "Document read source is unavailable.");
      }
      ctx.signal.throwIfAborted();
      const snapshot = await host.documentReadSource(
        ctx.sessionId,
        ctx.inputContext ?? { source: "disk" },
        authorized.resourceId,
      );
      ctx.signal.throwIfAborted();
      if (snapshot.status === "disk") return { source: "disk" };
      if (snapshot.status === "working-branch") {
        if (snapshot.message) throw new HarnessServiceError("unavailable", snapshot.message);
        return {
          source: "working-branch",
          revision: snapshot.revision,
          provenance: snapshot.provenance,
          ...(snapshot.missing ? { missing: true as const } : {}),
          ...(snapshot.base64 === undefined ? {} : { base64: snapshot.base64 }),
        };
      }
      if (snapshot.status === "unavailable") {
        throw new HarnessServiceError("unavailable", snapshot.message);
      }
      let bytes: Buffer;
      try {
        bytes = encodeDocumentText({
          content: snapshot.content,
          encoding: snapshot.encoding,
          bom: snapshot.bom,
        });
      } catch (error) {
        throw new HarnessServiceError(
          "failed",
          error instanceof Error ? error.message : "Unable to encode the editor source snapshot",
        );
      }
      return {
        base64: bytes.toString("base64"),
        revision: snapshot.revision,
        source: "surface-draft",
      };
    },
  };
}

const isOverlayRelativePath = (value: string): boolean => {
  const normalized = normalizeGlobPath(value);
  return normalized === "."
    || (normalized.length > 0 && normalized !== ".." && !normalized.startsWith("../"));
};

/**
 * Return only path identities from a fixed editor snapshot. The router has
 * already authorized the requested root with allowMissing, so a virtual root
 * can be listed without materializing its content in the request channel.
 */
export function createDocumentPathOverlayService(
  host: Pick<HarnessServiceHost, "documentPathOverlay">,
): HarnessService<"document.pathOverlay"> {
  return {
    handle: async (params, ctx) => {
      const authorized = ctx.authorizedPaths[0];
      if (!host.documentPathOverlay || !authorized || ctx.authorizedPaths.length !== 1) {
        throw new HarnessServiceError("unavailable", "Document path overlay is unavailable.");
      }
      ctx.signal.throwIfAborted();
      const snapshot = await host.documentPathOverlay(
        ctx.sessionId,
        ctx.inputContext ?? { source: "disk" },
        authorized.resourceId,
      );
      ctx.signal.throwIfAborted();
      if (snapshot.status === "disk") return { status: "disk" };
      if (snapshot.status === "unavailable") {
        throw new HarnessServiceError("unavailable", snapshot.message);
      }
      const pattern = params.pattern === undefined ? null : compileFindGlob(params.pattern);
      if (params.pattern !== undefined && !pattern) {
        throw new HarnessServiceError("unavailable", "The find glob pattern is invalid.");
      }
      const entries = snapshot.entries
        .filter((entry) => isOverlayRelativePath(entry.path))
        .filter((entry) => entry.path === "."
          || pattern === null
          || pattern((normalizeGlobPath(authorized.resourceId)
            ? `${normalizeGlobPath(authorized.resourceId)}/`
            : "") + normalizeGlobPath(entry.path).replace(/\/$/u, "")))
        .map((entry) => ({
          path: normalizeGlobPath(entry.path),
          kind: entry.kind,
          ...(entry.revision === undefined ? {} : { revision: entry.revision }),
        }));
      return {
        status: "ready",
        entries,
        ...("authority" in snapshot && snapshot.authority ? { authority: snapshot.authority } : {}),
      };
    },
  };
}

const normalizeBranchWriteChanges = (
  params: import("@piarium/protocol").DocumentBranchWriteParams,
): import("@piarium/protocol").DocumentBranchWriteChange[] | null => {
  if (params.changes && params.changes.length > 0) return [...params.changes];
  if (params.path && params.action) {
    return [{
      path: params.path,
      action: params.action,
      ...(params.content === undefined ? {} : { content: params.content }),
      ...(params.edits === undefined ? {} : { edits: params.edits }),
    }];
  }
  return null;
};

export function createDocumentBranchWriteService(
  host: Pick<HarnessServiceHost, "documentBranchWrite">,
): HarnessService<"document.branchWrite"> {
  return {
    handle: async (params, ctx) => {
      const changes = normalizeBranchWriteChanges(params);
      if (!host.documentBranchWrite || !changes || changes.length === 0 || ctx.authorizedPaths.length !== changes.length) {
        throw new HarnessServiceError("unavailable", "Working-branch write is unavailable.");
      }
      ctx.signal.throwIfAborted();
      const mapped = changes.map((change, index) => ({
        resourceId: ctx.authorizedPaths[index]!.resourceId,
        action: change.action,
        ...(change.content === undefined ? {} : { content: change.content }),
        ...(change.edits === undefined ? {} : { edits: change.edits }),
      }));
      return host.documentBranchWrite(
        ctx.sessionId,
        mapped,
        params.expectedRevision,
      );
    },
  };
}

export function createWorkingBranchEnsureMaterializedService(
  host: Pick<HarnessServiceHost, "workingBranchEnsureMaterialized">,
): HarnessService<"workingBranch.ensureMaterialized"> {
  return {
    handle: async (_params, ctx) => {
      if (!host.workingBranchEnsureMaterialized) {
        throw new HarnessServiceError("unavailable", "Working-branch materialization is unavailable.");
      }
      ctx.signal.throwIfAborted();
      return host.workingBranchEnsureMaterialized(ctx.sessionId, ctx.signal);
    },
  };
}

async function requireMaterializedDirectory(
  host: Pick<HarnessServiceHost, "workingBranchEnsureMaterialized">,
  sessionId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!host.workingBranchEnsureMaterialized) return null;
  const result = await host.workingBranchEnsureMaterialized(sessionId, signal);
  return result.status === "failed" ? result.message : null;
}

/**
 * Decide whether a native write may proceed on one path. Reads follow this
 * turn's fixed draft while writes apply to disk, so a divergent draft is
 * reported as an actionable conflict instead of being silently persisted
 * (D-089). The Router authorized the path with `allowMissing`, since a dirty
 * document may not exist on disk yet.
 */
export function createDocumentWriteGuardService(
  host: Pick<HarnessServiceHost, "documentWriteGuard">,
): HarnessService<"document.writeGuard"> {
  return {
    handle: async (_params, ctx) => {
      const authorized = ctx.authorizedPaths[0];
      if (!host.documentWriteGuard || !authorized || ctx.authorizedPaths.length !== 1) {
        throw new HarnessServiceError("unavailable", "Document write guard is unavailable.");
      }
      ctx.signal.throwIfAborted();
      return host.documentWriteGuard(
        ctx.sessionId,
        ctx.inputContext ?? { source: "disk" },
        authorized.resourceId,
      );
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
        signal: ctx.signal,
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
      const material = params.memoryMode === "off"
        ? { ...result.material, blocks: [] }
        : result.material;
      const reviews = threads && threads.status === "ready"
        ? threads.items.flatMap((thread) => {
            const review = thread.verification?.review;
            if (!review || review.status === "none") return [];
            return [{
              threadId: thread.id,
              resultRevision: review.resultRevision,
              status: review.status,
              ...(review.conclusion ? { conclusion: review.conclusion } : {}),
              ...(review.findings ? { findings: review.findings } : {}),
              ...(review.error ? { error: review.error } : {}),
            }];
          })
        : [];
      const content = assembleZone2Content({ ...material, threads, reviews }, { eventCursor: result.eventCursor });
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
          mode: params.mode,
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
        const blocks = await deps.store.getBlocks(ctx.sessionId, params.branchEntryIds);
        host.keeperCoverageStore.extend(ctx.sessionId, params.coveredEntryIds, {
          branchEntryIds: params.branchEntryIds,
          blocks: blocks.map((block) => ({ label: block.label, revision: block.updatedAt })),
        });
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
        params.branchEntryIds,
      );
      return { text: result.text };
    },
  };
}

export function createKnowledgeSuggestService(host: HarnessServiceHost): HarnessService<"knowledge.suggest"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      if (!host.knowledgeSuggestDepsProvider) {
        throw new HarnessServiceError("unavailable", "Knowledge suggestion deps not configured");
      }
      // `knowledge.suggest` is an internal worker entry point for user-message
      // proposals. Its authority is always the actor's workspace; scope and
      // source kind are deliberately not worker-controlled. Keep rejecting
      // forged legacy fields at runtime even though the public protocol type
      // no longer exposes them.
      const rawParams = params as unknown as Record<string, unknown>;
      if (rawParams.scope !== undefined || rawParams.kind !== undefined) {
        throw new HarnessServiceError("invalid-params", "knowledge.suggest accepts no scope or source kind");
      }
      const content = typeof params.content === "string" ? params.content : "";
      if (!content.trim()) return { created: false, skippedReason: "empty" };
      if (!ctx.workspaceId || ctx.workspaceId === "user") return { created: false, skippedReason: "no-workspace" };
      const deps = await host.knowledgeSuggestDepsProvider(ctx.sessionId, ctx.workspaceId);
      if (!deps) return { created: false, skippedReason: "no-workspace" };
      const result = await proposeUserMessageSuggestion({
        trigger: "user-message",
        content,
        recallTrigger: typeof params.trigger === "string" ? params.trigger : "",
        sessionId: ctx.sessionId,
        kind: "user-message",
        scope: "workspace",
      }, deps);
      if (result.created) deps.onChanged?.();
      return result;
    },
  };
}

export function createRecallSearchService(host: HarnessServiceHost): HarnessService<"recall.search"> {
  return {
    handle: async (params, ctx: HarnessServiceContext) => {
      if (!host.recallDepsProvider) {
        throw new HarnessServiceError("unavailable", "Recall deps not configured");
      }
      const deps = await host.recallDepsProvider(ctx.sessionId, ctx.workspaceId);
      const k = params.k ?? 5;
      const result = await executeRecall(params.query, k, deps, ctx.signal);
      return {
        text: result.text,
        results: result.results.map((r) => {
          const payload = r.node.payload as Record<string, unknown>;
          const scope = (payload["scope"] as string) ?? "workspace";
          const content = (payload["content"] as string) ?? "";
          const title = content.split("\n")[0] ?? content;
          return { scope, title, via: r.via, id: r.node.id };
        }),
        details: result.details,
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
  if (host.documentReadSource) {
    router.register("document.readSource", createDocumentReadSourceService(host));
  }
  if (host.documentPathOverlay) {
    router.register("document.pathOverlay", createDocumentPathOverlayService(host));
  }
  if (host.documentWriteGuard) {
    router.register("document.writeGuard", createDocumentWriteGuardService(host));
  }
  if (host.documentBranchWrite) {
    router.register("document.branchWrite", createDocumentBranchWriteService(host));
  }
  if (host.workingBranchEnsureMaterialized) {
    router.register("workingBranch.ensureMaterialized", createWorkingBranchEnsureMaterializedService(host));
  }
  router.register("fs.lock", createFsLockService(host.pathLockService));
  if (host.diagnosticsProvider) {
    router.register("lsp.diagnostics", createLspDiagnosticsService(host.diagnosticsProvider));
    router.register("lsp.diagnosticsSnapshot", createLspDiagnosticsSnapshotService(host.diagnosticsProvider, host.observationCursors));
  }
  if (host.lspNavigationServices) {
    const wrapNavigation = <M extends "lsp.symbols" | "lsp.definition" | "lsp.references" | "lsp.hover">(
      service: import("./router.js").HarnessService<M>,
    ): import("./router.js").HarnessService<M> => ({
      handle: async (params, ctx) => {
        const materializeError = await requireMaterializedDirectory(host, ctx.sessionId, ctx.signal);
        if (materializeError) throw new HarnessServiceError("unavailable", materializeError);
        return service.handle(params, ctx);
      },
    });
    router.register("lsp.symbols", wrapNavigation(host.lspNavigationServices.symbols));
    router.register("lsp.definition", wrapNavigation(host.lspNavigationServices.definition));
    router.register("lsp.references", wrapNavigation(host.lspNavigationServices.references));
    router.register("lsp.hover", wrapNavigation(host.lspNavigationServices.hover));
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
  if (host.knowledgeSuggestDepsProvider) {
    router.register("knowledge.suggest", createKnowledgeSuggestService(host));
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
  router.register("explore.query.start", createExploreQueryStartService(host));
  router.register("explore.query.plan", createExploreQueryPlanService(host));
  router.register("explore.query.views", createExploreQueryViewsService(host));
  router.register("explore.query.select", createExploreQuerySelectService(host));
  router.register("explore.query.followup", createExploreQueryFollowupService(host));
  router.register("explore.query.finish", createExploreQueryFinishService(host));
  router.register("explore.query.cancel", createExploreQueryCancelService(host));
  router.register("explore.query.release", createExploreQueryReleaseService(host));
  router.register("related.query", createRelatedQueryService(host));
  router.register("surface.snapshot.commit", {
    handle: async (params, ctx) => host.commitAgentInputContext(ctx.sessionId, params.context),
  });
  router.register("surface.snapshot.release", {
    handle: async (params, ctx) => host.releaseAgentInputContext(ctx.sessionId, params.context),
  });
}


export type { HarnessServiceMap };
