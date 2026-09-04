import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createThreadRegistry } from "./thread-registry.js";
import { createThreadDispatchService } from "./thread-services.js";

describe("thread services", () => {
  it("persists a starting Run and returns before worktree or child-session setup finishes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-dispatch-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    let markSpawnStarted!: () => void;
    const spawnStarted = new Promise<void>((resolve) => { markSpawnStarted = resolve; });
    const neverFinishes = new Promise<{ sessionId: string }>(() => {});
    const spawn = vi.fn(async () => {
      markSpawnStarted();
      return neverFinishes;
    });
    const service = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: spawn,
    } as never);

    try {
      const result = await service.handle({
        concurrency: 1,
        role: "hard-implement",
        task: "Implement the vertical slice",
        model: { providerId: "openai", modelId: "gpt-test" },
      }, {
        actor: {
          authorityInstanceId: "authority-1",
          grantedCapabilities: ["control.thread"],
          sessionId: "parent-1",
          workerGeneration: 1,
          workerId: "worker-1",
          workspaceId: "workspace-1",
        },
        authorizedPaths: [],
        sessionId: "parent-1",
        signal: new AbortController().signal,
        workspaceId: "workspace-1",
      });
      await spawnStarted;

      expect(result.queued).toBe(false);
      expect(spawn).toHaveBeenCalledOnce();
      expect(await registry.getActiveRun("workspace-1", result.threadId)).toMatchObject({
        workerState: "starting",
        outcome: null,
      });
      const queued = await service.handle({
        concurrency: 1,
        role: "hard-implement",
        task: "Wait for the slot",
        model: { providerId: "openai", modelId: "gpt-test" },
      }, {
        actor: {
          authorityInstanceId: "authority-1",
          grantedCapabilities: ["control.thread"],
          sessionId: "parent-1",
          workerGeneration: 1,
          workerId: "worker-1",
          workspaceId: "workspace-1",
        },
        authorizedPaths: [],
        sessionId: "parent-1",
        signal: new AbortController().signal,
        workspaceId: "workspace-1",
      });
      expect(queued.queued).toBe(true);
      expect(spawn).toHaveBeenCalledOnce();
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });
});
