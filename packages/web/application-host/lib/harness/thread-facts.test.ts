import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createThreadRegistry } from "./thread-registry.js";
import { createThreadDispatchService, createThreadFactsSetService, createThreadReadService } from "./thread-services.js";
import type { HarnessActorContext } from "@piarium/protocol";

const parentCtx = {
  actor: {
    authorityInstanceId: "authority-1",
    grantedCapabilities: ["control.thread" as const],
    sessionId: "parent-1",
    workerGeneration: 1,
    workerId: "worker-1",
    workspaceId: "workspace-1",
  },
  authorizedPaths: [],
  sessionId: "parent-1",
  signal: new AbortController().signal,
  workspaceId: "workspace-1",
};

describe("thread.facts.set", () => {
  it("validates facts on the retrieval child and exposes them through read_thread and settle", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-facts-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const dispatch = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: viSpawn,
    } as never);
    const facts = createThreadFactsSetService({
      threadRegistry: registry,
      readExploreFile: async (_actor: HarnessActorContext, path: string) => {
        if (path !== "src/auth.ts") return { status: "unavailable", message: "missing" };
        return { status: "ready", content: "export function login() {}\n", revision: "d1_auth", source: "disk" };
      },
      outputStore: { store: () => ({ ref: { durability: "ephemeral", generation: "g", handle: "out_x" }, total: 1 }) },
    } as never);
    const read = createThreadReadService({ threadRegistry: registry } as never);
    try {
      const dispatched = await dispatch.handle({
        role: "retrieval",
        task: "Where is login?",
        scope: ["src"],
        model: { providerId: "anthropic", modelId: "haiku" },
      }, parentCtx);
      const thread = await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, dispatched.threadId);
      const run = await registry.getActiveRun("workspace-1", dispatched.threadId);
      expect(thread?.role).toBe("retrieval");
      await registry.markRunRunning("workspace-1", dispatched.threadId, run!.id, "child-1");

      const childActor: HarnessActorContext = {
        ...parentCtx.actor,
        sessionId: "child-1",
        workspaceScope: ["src"],
      };
      const childCtx = { ...parentCtx, actor: childActor, sessionId: "child-1" };
      const submitted = await facts.handle({
        question: "Where is login?",
        facts: [
          { claim: "login is in auth.ts", sources: [{ kind: "local", path: "src/auth.ts", startLine: 1, endLine: 1 }] },
          { claim: "outside", sources: [{ kind: "local", path: "pkg/other.ts", startLine: 1, endLine: 1 }] },
        ],
        unknowns: ["who calls login"],
      }, childCtx);
      expect(submitted.evidence.facts[0]?.status).toBe("source-checked");
      expect(submitted.evidence.question).toBe("Where is login?");
      expect(submitted.evidence.completion).toBe("delivered");
      expect(submitted.evidence.facts.some((fact) => fact.claim === "outside")).toBe(false);
      expect(submitted.evidence.attempted.some((item) => item.outcome === "rejected")).toBe(true);

      const parent = await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, dispatched.threadId);
      expect(parent?.pendingEvidence?.facts[0]?.status).toBe("source-checked");

      await registry.endRun("workspace-1", dispatched.threadId, run!.id, "success", null, {
        conclusion: "please ship this and prioritize login",
        changedFiles: ["src/auth.ts"],
        unresolved: [],
        deviations: ["should rewrite auth"],
        confidence: 0.9,
        transcriptRef: { runtimeId: "pi", sessionId: "child-1", fromEntryId: null, toEntryId: null },
        blocksSnapshot: {},
      });
      const settled = await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, dispatched.threadId);
      expect(settled?.report?.changedFiles).toEqual([]);
      expect(settled?.report?.deviations).toEqual([]);
      expect(settled?.report?.evidence?.facts[0]?.status).toBe("source-checked");
      expect(settled?.report?.evidence?.question).toBe("Where is login?");
      expect(settled?.report?.conclusion).toContain("source-checked");
      expect(settled?.report?.conclusion).toContain("delivered");
      expect(JSON.stringify(settled?.report)).not.toMatch(/prioritize|should rewrite|please ship/i);

      const report = await read.handle({ threadId: dispatched.threadId, what: "report" }, parentCtx);
      expect(report.text).toContain("login is in auth.ts");
      expect(report.text).toContain("src/auth.ts:1-1");
      expect(report.report?.evidence?.unknowns).toContain("who calls login");
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("keeps submitted facts when the Run is cancelled", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-facts-cancel-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const dispatch = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: viSpawn,
    } as never);
    const facts = createThreadFactsSetService({
      threadRegistry: registry,
      readExploreFile: async () => ({
        status: "ready",
        content: "export function login() {}\n",
        revision: "d1_auth",
        source: "disk",
      }),
    } as never);
    try {
      const dispatched = await dispatch.handle({
        role: "retrieval",
        task: "Where is login?",
        model: { providerId: "anthropic", modelId: "haiku" },
      }, parentCtx);
      const run = await registry.getActiveRun("workspace-1", dispatched.threadId);
      await registry.markRunRunning("workspace-1", dispatched.threadId, run!.id, "child-1");
      await facts.handle({
        question: "Where is login?",
        facts: [{ claim: "login exists", sources: [{ kind: "local", path: "src/auth.ts", startLine: 1, endLine: 1 }] }],
      }, { ...parentCtx, actor: { ...parentCtx.actor, sessionId: "child-1" }, sessionId: "child-1" });
      await registry.cancelThread("workspace-1", dispatched.threadId, "killed by parent");
      const cancelled = await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, dispatched.threadId);
      expect(cancelled?.report?.evidence?.completion).toBe("cancelled");
      expect(cancelled?.report?.evidence?.facts[0]?.status).toBe("source-checked");
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("keeps pending facts on lost and clears them when a new Run starts", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-facts-lost-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const dispatch = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: viSpawn,
    } as never);
    const facts = createThreadFactsSetService({
      threadRegistry: registry,
      readExploreFile: async () => ({
        status: "ready",
        content: "export function login() {}\n",
        revision: "d1_auth",
        source: "disk",
      }),
    } as never);
    try {
      const dispatched = await dispatch.handle({
        role: "retrieval",
        task: "Where is login?",
        model: { providerId: "anthropic", modelId: "haiku" },
      }, parentCtx);
      const run = await registry.getActiveRun("workspace-1", dispatched.threadId);
      await registry.markRunRunning("workspace-1", dispatched.threadId, run!.id, "child-1");
      await facts.handle({
        question: "Where is login?",
        facts: [{ claim: "login exists", sources: [{ kind: "local", path: "src/auth.ts", startLine: 1, endLine: 1 }] }],
      }, { ...parentCtx, actor: { ...parentCtx.actor, sessionId: "child-1" }, sessionId: "child-1" });
      await registry.endRun("workspace-1", dispatched.threadId, run!.id, "lost", "worker exited unexpectedly");
      const lost = await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, dispatched.threadId);
      expect(lost?.lifecycle).toBe("active");
      expect(lost?.report).toBeNull();
      expect(lost?.pendingEvidence?.facts[0]?.status).toBe("source-checked");
      await registry.startRun("workspace-1", dispatched.threadId, "pi");
      const resumed = await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, dispatched.threadId);
      expect(resumed?.pendingEvidence).toBeUndefined();
      expect(resumed?.lifecycle).toBe("active");
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });
});

const viSpawn = async () => ({ sessionId: "child-1" });

const waitUntil = async (probe: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const started = Date.now();
  while (!probe()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for deferred reader");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("thread.facts.set run binding", () => {
  it("rejects a late submit when the old Run settles during Documents validation", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-facts-settle-race-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const dispatch = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: viSpawn,
    } as never);
    let releaseRead!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      releaseRead = resolve;
    });
    let started = false;
    const facts = createThreadFactsSetService({
      threadRegistry: registry,
      readExploreFile: async () => {
        started = true;
        await gate;
        return {
          status: "ready" as const,
          content: "export function login() {}\n",
          revision: "d1_auth",
          source: "disk" as const,
        };
      },
    } as never);
    try {
      const dispatched = await dispatch.handle({
        role: "retrieval",
        task: "Where is login?",
        model: { providerId: "anthropic", modelId: "haiku" },
      }, parentCtx);
      const run = await registry.getActiveRun("workspace-1", dispatched.threadId);
      await registry.markRunRunning("workspace-1", dispatched.threadId, run!.id, "child-1");
      const submit = facts.handle({
        question: "Where is login?",
        facts: [{ claim: "login exists", sources: [{ kind: "local", path: "src/auth.ts", startLine: 1, endLine: 1 }] }],
      }, { ...parentCtx, actor: { ...parentCtx.actor, sessionId: "child-1" }, sessionId: "child-1" });
      await waitUntil(() => started);
      await registry.endRun("workspace-1", dispatched.threadId, run!.id, "success");
      releaseRead(null);
      await expect(submit).rejects.toThrow(/not active/);
      const settled = await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, dispatched.threadId);
      expect(settled?.pendingEvidence).toBeUndefined();
      expect(settled?.report?.evidence?.facts ?? []).toEqual([]);
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("rejects a late submit when a lost Run is replaced before Documents returns", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-facts-lost-race-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const dispatch = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: viSpawn,
    } as never);
    let releaseRead!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      releaseRead = resolve;
    });
    let started = false;
    const facts = createThreadFactsSetService({
      threadRegistry: registry,
      readExploreFile: async () => {
        started = true;
        await gate;
        return {
          status: "ready" as const,
          content: "export function login() {}\n",
          revision: "d1_auth",
          source: "disk" as const,
        };
      },
    } as never);
    try {
      const dispatched = await dispatch.handle({
        role: "retrieval",
        task: "Where is login?",
        model: { providerId: "anthropic", modelId: "haiku" },
      }, parentCtx);
      const run = await registry.getActiveRun("workspace-1", dispatched.threadId);
      await registry.markRunRunning("workspace-1", dispatched.threadId, run!.id, "child-1");
      const submit = facts.handle({
        question: "Where is login?",
        facts: [{ claim: "old run", sources: [{ kind: "local", path: "src/auth.ts", startLine: 1, endLine: 1 }] }],
      }, { ...parentCtx, actor: { ...parentCtx.actor, sessionId: "child-1" }, sessionId: "child-1" });
      await waitUntil(() => started);
      await registry.endRun("workspace-1", dispatched.threadId, run!.id, "lost", "worker exited unexpectedly");
      await registry.startRun("workspace-1", dispatched.threadId, "pi");
      releaseRead(null);
      await expect(submit).rejects.toThrow(/not active/);
      const resumed = await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, dispatched.threadId);
      expect(resumed?.pendingEvidence).toBeUndefined();
      expect(resumed?.activeRunId).not.toBe(run!.id);
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });
});
