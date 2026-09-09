import { describe, expect, it } from "vitest";
import type { AgentInputContext, HarnessActorContext } from "@piarium/protocol";
import {
  createExploreQueryCancelService,
  createExploreQueryStartService,
  createExploreQueryViewsService,
} from "./explore-query-services.js";
import { createExploreQueryStore } from "./explore-query-store.js";
import type { HarnessServiceContext } from "./router.js";
import type { HarnessServiceHost } from "./service-host.js";

const actor: HarnessActorContext = {
  authorityInstanceId: "test-host",
  sessionId: "test-session",
  workerId: "worker",
  workerGeneration: 1,
  workspaceId: "workspace-1",
  grantedCapabilities: ["read.search"],
};

const surface: AgentInputContext = {
  source: "surface",
  workspaceId: "workspace-1",
  dirtyPaths: ["a.ts"],
  snapshot: { status: "ready", ref: "surface" },
};

function context(inputContext: AgentInputContext, signal = new AbortController().signal): HarnessServiceContext {
  return {
    actor,
    authorizedPaths: [],
    sessionId: actor.sessionId,
    workspaceId: actor.workspaceId,
    inputContext,
    signal,
  };
}

describe("explore query services", () => {
  it("keeps the start input source when a later stage RPC sends a different window", async () => {
    const seen: AgentInputContext[] = [];
    const store = createExploreQueryStore();
    const host = {
      exploreQueryStore: store,
      searchService: {
        search: async (_request: unknown, options: { inputContext?: AgentInputContext }) => {
          if (options.inputContext) seen.push(options.inputContext);
          return {
            status: "ready",
            files: [{ path: "a.ts", hits: [{ line: 1, text: "needle", before: [], after: [] }] }],
            partial: false,
          };
        },
      },
      readExploreFile: async (
        _actor: HarnessActorContext,
        _path: string,
        _signal: AbortSignal,
        inputContext: AgentInputContext,
      ) => {
        seen.push(inputContext);
        return { status: "ready" as const, content: "needle", revision: "rev-1", source: inputContext.source };
      },
    } as unknown as Pick<
      HarnessServiceHost,
      "searchService" | "readExploreFile" | "structureSource" | "graphRecall" | "semanticRecall" | "agentInputDraftPaths" | "exploreQueryStore"
    >;
    const started = await createExploreQueryStartService(host).handle({ question: "needle" }, context(surface));
    expect(started.inputSource).toBe("surface");
    await createExploreQueryViewsService(host).handle(
      { queryId: started.queryId },
      context({ source: "disk" }),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((entry) => entry.source === "surface")).toBe(true);
    store.dispose();
  });

  it("rejects a later actor with a new generation and drops queries on session cleanup", async () => {
    const store = createExploreQueryStore();
    const host = {
      exploreQueryStore: store,
      searchService: {
        search: async () => ({
          status: "ready",
          files: [{ path: "a.ts", hits: [{ line: 1, text: "needle", before: [], after: [] }] }],
          partial: false,
        }),
      },
      readExploreFile: async () => ({ status: "ready" as const, content: "needle", revision: "rev-1", source: "disk" as const }),
    } as unknown as Pick<
      HarnessServiceHost,
      "searchService" | "readExploreFile" | "structureSource" | "graphRecall" | "semanticRecall" | "agentInputDraftPaths" | "exploreQueryStore"
    >;
    const started = await createExploreQueryStartService(host).handle({ question: "needle" }, context({ source: "disk" }));
    const nextActor = { ...actor, workerGeneration: 2 };
    await expect(createExploreQueryViewsService(host).handle(
      { queryId: started.queryId },
      { ...context({ source: "disk" }), actor: nextActor },
    )).rejects.toMatchObject({ harnessCode: "forbidden" });
    expect(store.get(actor.sessionId, started.queryId)).toBeDefined();
    store.dropSession(actor.sessionId);
    expect(store.get(actor.sessionId, started.queryId)).toBeUndefined();
    store.dispose();
  });

  it("aborts Host search when the bound actor cancels the query", async () => {
    const store = createExploreQueryStore();
    let sawAbort = false;
    let resolveEntered!: () => void;
    const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
    const host = {
      exploreQueryStore: store,
      searchService: {
        search: async (_request: unknown, options: { signal?: AbortSignal }) => {
          resolveEntered();
          await new Promise<void>((_resolve, reject) => {
            const fail = (): void => {
              sawAbort = true;
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            };
            if (options.signal?.aborted) fail();
            else options.signal?.addEventListener("abort", fail, { once: true });
          });
          return { status: "ready", files: [], partial: false };
        },
      },
      readExploreFile: async () => ({ status: "ready" as const, content: "needle", revision: "rev-1", source: "disk" as const }),
    } as unknown as Pick<
      HarnessServiceHost,
      "searchService" | "readExploreFile" | "structureSource" | "graphRecall" | "semanticRecall" | "agentInputDraftPaths" | "exploreQueryStore"
    >;
    const started = await createExploreQueryStartService(host).handle({ question: "needle" }, context({ source: "disk" }));
    await entered;
    const cancelled = await createExploreQueryCancelService(host).handle(
      { queryId: started.queryId },
      context({ source: "disk" }),
    );
    expect(cancelled.cancelled).toBe(true);
    await Promise.resolve();
    expect(sawAbort).toBe(true);
    store.dispose();
  });

  it("releases a started query when its response is not delivered", async () => {
    const store = createExploreQueryStore();
    const host = {
      exploreQueryStore: store,
      searchService: {
        search: async () => ({ status: "ready", files: [], partial: false }),
      },
      readExploreFile: async () => ({ status: "ready" as const, content: "needle", revision: "rev-1", source: "disk" as const }),
    } as unknown as Pick<
      HarnessServiceHost,
      "searchService" | "readExploreFile" | "structureSource" | "graphRecall" | "semanticRecall" | "agentInputDraftPaths" | "exploreQueryStore"
    >;
    let abortDelivery!: () => void;
    const ctx: HarnessServiceContext = {
      ...context({ source: "disk" }),
      deferResponseDelivery: (_commit, abort) => { abortDelivery = abort; },
    };
    const started = await createExploreQueryStartService(host).handle({ question: "needle" }, ctx);
    expect(store.get(actor.sessionId, started.queryId)).toBeDefined();
    abortDelivery();
    expect(store.get(actor.sessionId, started.queryId)).toBeUndefined();
    store.dispose();
  });

  it("uses the actor scope for graph, semantic, vocabulary, and follow-up paths", async () => {
    const store = createExploreQueryStore();
    const scopedActor: HarnessActorContext = { ...actor, workspaceScope: ["packages/allowed"] };
    const readPaths: string[] = [];
    const graph = {
      catalogStats: async () => ({
        symbolCount: 2,
        fileCount: 2,
        paths: ["packages/allowed/src/index.ts", "packages/secret/src/index.ts"],
      }),
      searchSymbols: async () => [
        { name: "NeedleSymbol", path: "packages/allowed/src/index.ts", kind: "function", match: "exact", score: 1 },
        { name: "NeedleSymbol", path: "packages/secret/src/index.ts", kind: "function", match: "exact", score: 1 },
      ],
      findLinks: async () => [],
      getFileRelations: async () => null,
      findImporters: async () => ({ resolved: [], unresolved: [] }),
    };
    const semanticHit = (documentId: string, blockId: string) => ({
      documentId,
      blockId,
      parentUnitId: blockId,
      parentName: "NeedleSymbol",
      parentKind: "function",
      startLine: 1,
      endLine: 1,
      contentHash: blockId,
      body: "export function NeedleSymbol() {}",
      similarity: 0.9,
      rank: 1,
    });
    const host = {
      exploreQueryStore: store,
      searchService: {
        search: async () => ({ status: "ready", files: [], partial: false }),
      },
      readExploreFile: async (_actor: HarnessActorContext, path: string) => {
        readPaths.push(path);
        return { status: "ready" as const, content: "export function NeedleSymbol() {}", revision: "rev-1", source: "disk" as const };
      },
      graphRecall: () => graph,
      semanticRecall: async () => ({
        status: "ready" as const,
        coverage: "complete" as const,
        lifecycle: "ready" as const,
        hits: [
          semanticHit("packages/allowed/src/index.ts", "allowed"),
          semanticHit("packages/secret/src/index.ts", "secret"),
        ],
      }),
    } as unknown as Pick<
      HarnessServiceHost,
      "searchService" | "readExploreFile" | "structureSource" | "graphRecall" | "semanticRecall" | "agentInputDraftPaths" | "exploreQueryStore"
    >;
    const scopedContext: HarnessServiceContext = {
      ...context({ source: "disk" }),
      actor: scopedActor,
      workspaceScope: ["packages/allowed"],
    };
    const started = await createExploreQueryStartService(host).handle({ question: "NeedleSymbol" }, scopedContext);
    expect(store.get(actor.sessionId, started.queryId)?.paths).toEqual(["packages/allowed"]);
    expect(started.vocab.catalog).toBeUndefined();
    expect(started.vocab.packages).toEqual(["packages/allowed"]);
    expect(started.vocab.entries).toEqual(["packages/allowed/src/index.ts"]);
    const views = await createExploreQueryViewsService(host).handle({ queryId: started.queryId }, scopedContext);
    const result = store.get(actor.sessionId, started.queryId)!.run.finish();
    expect(readPaths).toContain("packages/allowed/src/index.ts");
    expect(readPaths.every((path) => path.startsWith("packages/allowed/"))).toBe(true);
    expect(JSON.stringify({ started, views, result })).not.toContain("packages/secret");
    store.dispose();
  });
});
