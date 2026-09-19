import { describe, expect, it } from "vitest";
import type { HarnessServiceHost } from "./service-host.js";
import type { ShellCommandCompletedEvent } from "./shell-supervisor.js";
import type { ManagedRemoteTargetRegistry } from "./managed-remote-client.js";
import { watchManagedShellCompletion } from "./harness-services.js";

describe("managed remote shell completion", () => {
  it("observes natural background exit once without a get_output call", async () => {
    let reads = 0;
    const observed: ShellCommandCompletedEvent[] = [];
    let resolveObserved!: () => void;
    const completed = new Promise<void>((resolve) => { resolveObserved = resolve; });
    const registry = {
      shellRead: async () => {
        reads += 1;
        return reads === 1
          ? { text: "working\n", offset: 0, length: 8, nextOffset: 8, total: 8, eof: false, running: true }
          : { text: "done\n", offset: 8, length: 5, nextOffset: 13, total: 13, eof: true, running: false, exitCode: 0 };
      },
    } as unknown as ManagedRemoteTargetRegistry;
    const host = {
      managedRemoteTargets: registry,
      observeShellCompletion: (_sessionId: string, event: ShellCommandCompletedEvent) => {
        observed.push(event);
        resolveObserved();
      },
    } as unknown as HarnessServiceHost;
    const watch = {
      sessionId: "session-1",
      workspaceId: "workspace-1",
      shellId: "mrsh:opaque",
      command: "run experiment",
      cwd: "/target/work",
      toolCallId: "tool-1",
      executionId: "mrsh:execution",
      startedAt: 100,
    };

    watchManagedShellCompletion(host, watch);
    watchManagedShellCompletion(host, watch);
    await Promise.race([
      completed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("completion was not observed")), 1_000)),
    ]);

    expect(reads).toBe(2);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      command: "run experiment",
      executionId: "mrsh:execution",
      exitCode: 0,
      cancelled: false,
      outputPreview: "working\ndone\n",
    });
  });
});
