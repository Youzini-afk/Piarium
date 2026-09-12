import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createThreadRegistry, type CreateThreadInput } from "./thread-registry.js";
import { createThreadMemoryReturnAdapter } from "./thread-memory-return.js";
import type { ThreadReport } from "@piarium/protocol";

it("delivers real Registry returns to the owning live parent session across execution workspaces", async () => {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "thread-memory-return-"));
  const deliveries: Promise<void>[] = [];
  const registry = createThreadRegistry({
    hostId: "host", dataDir,
    onThreadReturned: (...args) => { deliveries.push(adapter(...args)); },
  });
  const live = new Set(["root-pi", "parent-materialized-pi"]);
  const rootWorkspace = vi.fn((sessionId: string) => sessionId === "root-pi" ? "owning" : "execution");
  const nudgeMemory = vi.fn(async () => undefined);
  const adapter = createThreadMemoryReturnAdapter({
    registry, hasLiveSession: (sessionId) => live.has(sessionId), rootSessionWorkspaceId: rootWorkspace, nudgeMemory,
  });
  const input: CreateThreadInput = {
    workspaceId: "owning", parent: { kind: "session", id: "root-pi" }, brief: "work", kind: "implementation", createdBy: "agent",
    concurrency: 8, autoRun: true, worktree: "isolated", tools: [], permissions: {},
  };
  const report: ThreadReport = {
    conclusion: "Same conclusion", changedFiles: [], unresolved: ["Still incomplete"], deviations: [], confidence: 0.4,
    transcriptRef: { runtimeId: "pi", sessionId: "child-pi", fromEntryId: null, toEntryId: null }, blocksSnapshot: {},
  };
  try {
    const parent = await registry.createThread(input);
    const parentRun = await registry.startRun("owning", parent.id);
    await registry.markRunRunning("owning", parent.id, parentRun.id, "parent-materialized-pi");
    const child = await registry.createThread({ ...input, parent: { kind: "thread", id: parent.id } });
    const first = await registry.startRun("owning", child.id);
    await registry.endRun("owning", child.id, first.id, "failure", "check failed", report);
    await Promise.all(deliveries.splice(0));
    expect(nudgeMemory).toHaveBeenCalledWith("parent-materialized-pi", expect.objectContaining({
      id: `thread-return:owning:${child.id}:${first.id}`, text: expect.stringContaining("persisted failure report"),
    }));
    expect(rootWorkspace).not.toHaveBeenCalled();

    const second = await registry.startRun("owning", child.id, "pi", { allowSettled: true });
    await registry.endRun("owning", child.id, second.id, "success", null, report);
    await Promise.all(deliveries.splice(0));
    expect(nudgeMemory).toHaveBeenLastCalledWith("parent-materialized-pi", expect.objectContaining({
      id: `thread-return:owning:${child.id}:${second.id}`,
    }));
    live.delete("parent-materialized-pi");
    const third = await registry.startRun("owning", child.id, "pi", { allowSettled: true });
    await registry.endRun("owning", child.id, third.id, "success", null, report);
    await Promise.all(deliveries.splice(0));
    expect(nudgeMemory).toHaveBeenCalledTimes(2);

    await registry.endRun("owning", parent.id, parentRun.id, "cancelled", "user stopped", report);
    await Promise.all(deliveries.splice(0));
    expect(nudgeMemory).toHaveBeenLastCalledWith("root-pi", expect.objectContaining({ text: expect.stringContaining("persisted cancelled report") }));
    live.delete("root-pi");
    await adapter("owning", input.parent, parent.id, { ...parentRun, outcome: "success" }, report);
    expect(nudgeMemory).toHaveBeenCalledTimes(3);
    live.add("root-pi");
    await adapter("wrong-workspace", input.parent, parent.id, { ...parentRun, outcome: "success" }, report);
    expect(nudgeMemory).toHaveBeenCalledTimes(3);
  } finally {
    await registry.dispose();
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  }
});
