import { describe, expect, it } from "vitest";
import type { AgentInputContext, HarnessActorContext } from "@piarium/protocol";
import {
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
  generation: 1,
  ownerId: "surface",
  dirtyPaths: ["a.ts"],
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
});
