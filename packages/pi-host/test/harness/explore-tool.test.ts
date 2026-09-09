import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import type { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createExploreTool } from "../../src/harness/explore-tool.js";

const finishResult = {
  text: "1 excerpt(s)",
  snippets: [],
  issues: [],
  notRequested: { count: 0, paths: [] },
  omitted: [],
  partial: false,
  searched: { patterns: 1, files: 1, ms: 1, incomplete: false },
  handle: "out_test",
  details: {
    provenance: [],
    anchors: { supplied: ["createMemoryAgentExtension"], used: ["createMemoryAgentExtension"], truncated: 0 },
    byteBudget: 24576,
  },
};

describe("Host-backed explore tool", () => {
  it("T9: accepts anchors, forwards them, and describes conceptual mapping", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const bridge = {
      inputContext: () => ({ source: "disk" as const }),
      cancel: () => undefined,
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "explore.query.start") {
          return {
            queryId: "eq_test",
            question: params.question,
            deadlineAt: Date.now() + 1000,
            parsed: { objects: [], relation: "unknown", domain: "unknown" },
            vocab: { objects: [], anchors: params.anchors ?? [] },
            sources: [],
            inputSource: "disk",
          };
        }
        if (method === "explore.query.views") {
          return {
            queryId: "eq_test",
            question: "where is the factory",
            views: [],
            unevaluated: 0,
            sources: [],
            deadlineAt: Date.now() + 1000,
          };
        }
        if (method === "explore.query.finish") return finishResult;
        if (method === "explore.query.release") return { released: true };
        throw new Error(`unexpected ${method}`);
      },
    } as unknown as HostServicesBridge;
    const tool = createExploreTool(bridge, "session");

    assert.match(tool.description ?? "", /Locate relevant code and read the related context/);
    assert.match(tool.description ?? "", /anchors/);
    assert.match(tool.description ?? "", /conceptual names/);
    assert.doesNotMatch(tool.description ?? "", /Open question/);
    assert.doesNotMatch(tool.description ?? "", /broad questions/);
    assert.match(tool.promptSnippet ?? "", /conceptual questions/);
    assert.ok((tool.promptGuidelines ?? []).some((line) => /conceptual question and repository identifiers/i.test(line)));

    await tool.execute(
      "call",
      { question: "where is the factory", anchors: ["createMemoryAgentExtension"], limit: 3 },
      undefined,
      undefined,
      undefined as never,
    );

    assert.equal(calls[0]?.method, "explore.query.start");
    assert.equal(calls[0]?.params.question, "where is the factory");
    assert.deepEqual(calls[0]?.params.anchors, ["createMemoryAgentExtension"]);
    assert.equal(calls[0]?.params.limit, 3);
    assert.ok(calls.some((call) => call.method === "explore.query.views"));
    assert.ok(calls.some((call) => call.method === "explore.query.finish"));
    assert.ok(calls.some((call) => call.method === "explore.query.release"));
  });

  it("accepts a blank anchor at the schema layer so the Host can filter it", () => {
    const tool = createExploreTool({ request: async () => ({}) } as unknown as HostServicesBridge, "session");
    // The Host drops blank anchors and reports them in details.anchors. A stricter schema here
    // would reject the whole call instead, so the two layers must accept the same input.
    assert.equal(Value.Check(tool.parameters, { question: "needle", anchors: ["foo", ""] }), true);
    assert.equal(Value.Check(tool.parameters, { question: "needle", anchors: ["foo", "  "] }), true);
    assert.equal(Value.Check(tool.parameters, { question: "needle", anchors: [7] }), false);
  });

  it("does not mark select as used when the Host rejects every chosen view", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const bridge = {
      inputContext: () => ({ source: "disk" as const }),
      cancel: () => undefined,
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "explore.query.start") {
          return {
            queryId: "eq_test",
            question: params.question,
            deadlineAt: Date.now() + 10_000,
            parsed: { objects: [], relation: "unknown", domain: "unknown" },
            vocab: { objects: [], anchors: [] },
            sources: [],
            inputSource: "disk",
          };
        }
        if (method === "explore.query.views") {
          return {
            queryId: "eq_test",
            question: "how does reclaim work",
            views: [{
              viewId: "v1",
              path: "a.ts",
              startLine: 1,
              endLine: 1,
              text: "reclaim",
              revision: "r1",
              source: "disk",
              ranges: [{ rangeId: "v1:full", startLine: 1, endLine: 1 }],
              arrivals: [],
              assessment: "object-present",
              purpose: "candidate",
              why: "hit",
            }],
            unevaluated: 0,
            sources: [],
            deadlineAt: Date.now() + 10_000,
          };
        }
        if (method === "explore.query.select") {
          return { queryId: "eq_test", accepted: [], rejected: [{ viewId: "v1", reason: "unknown" }], gaps: [] };
        }
        if (method === "explore.query.finish") {
          return {
            ...finishResult,
            details: {
              ...finishResult.details,
              model: (params as { model?: { select?: string } }).model,
            },
          };
        }
        if (method === "explore.query.release") return { released: true };
        throw new Error(`unexpected ${method}`);
      },
    } as unknown as HostServicesBridge;
    const tool = createExploreTool(bridge, "session", {
      complete: async () => JSON.stringify({
        groups: [{ id: "sel1", purpose: "x", views: [{ viewId: "v1", rangeIds: ["v1:full"], required: true }] }],
      }),
    });
    const result = await tool.execute(
      "call",
      { question: "how does reclaim work" },
      undefined,
      undefined,
      undefined as never,
    );
    const finish = calls.find((call) => call.method === "explore.query.finish");
    assert.equal((finish?.params.model as { select?: string } | undefined)?.select, "skipped");
    assert.equal((result.details as { model?: { select?: string } }).model?.select, "skipped");
  });

  it("keeps an accepted selection when the optional incremental follow-up fails", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const view = (viewId: string, path: string) => ({
      viewId,
      path,
      startLine: 1,
      endLine: 1,
      text: "reclaim",
      revision: "r1",
      source: "disk",
      ranges: [{ rangeId: `${viewId}:full`, startLine: 1, endLine: 1 }],
      arrivals: [],
      assessment: "unverified",
      purpose: "candidate",
      why: "hit",
    });
    const bridge = {
      inputContext: () => ({ source: "disk" as const }),
      cancel: () => undefined,
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "explore.query.start") return {
          queryId: "eq_test",
          question: params.question,
          deadlineAt: Date.now() + 10_000,
          parsed: { objects: [], relation: "unknown", domain: "implementation" },
          vocab: { objects: [], anchors: [] },
          sources: [],
          inputSource: "disk",
        };
        if (method === "explore.query.plan") return { queryId: "eq_test", launched: ["reclaimLease"], reused: [], sources: [] };
        if (method === "explore.query.views") return {
          queryId: "eq_test",
          question: "how does reclaim work",
          views: [view("v1", "a.ts")],
          unevaluated: 0,
          sources: [],
          deadlineAt: Date.now() + 10_000,
        };
        if (method === "explore.query.select") return { queryId: "eq_test", accepted: [{ groupId: "sel1", viewIds: ["v1"] }], rejected: [], gaps: [] };
        if (method === "explore.query.followup") return { queryId: "eq_test", launched: ["reclaimNow"], reused: [], newViews: [view("v2", "b.ts")], sources: [] };
        if (method === "explore.query.finish") return {
          ...finishResult,
          details: { ...finishResult.details, model: (params as { model?: unknown }).model },
        };
        if (method === "explore.query.release") return { released: true };
        throw new Error(`unexpected ${method}`);
      },
    } as unknown as HostServicesBridge;
    let completion = 0;
    const tool = createExploreTool(bridge, "session", {
      complete: async () => {
        completion += 1;
        if (completion === 1) return JSON.stringify({ behavior: "reclaim", groups: [{ id: "g1", concept: "reclaim", expressions: ["reclaimLease"] }] });
        if (completion === 2) return JSON.stringify({
          groups: [{ id: "sel1", purpose: "reclaim path", views: [{ viewId: "v1", rangeIds: ["v1:full"], required: true }] }],
          followup: { searches: [{ expression: "reclaimNow" }] },
        });
        throw new Error("incremental model failed");
      },
    });
    await tool.execute("call", { question: "how does reclaim work" }, undefined, undefined, undefined as never);
    const finish = calls.find((call) => call.method === "explore.query.finish");
    assert.deepEqual(finish?.params.model, {
      plan: "used",
      select: "used",
      followup: "failed",
      note: "Explore follow-up failed; the earlier accepted material was kept.",
    });
  });
});
