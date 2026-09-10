import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIsolatedTerminalSessionApi } from "../terminal/isolated-session-api.js";
import { createOutputStore } from "./output-store.js";
import { createShellSupervisor, type PtyProcess, type PtyProvider } from "./shell-supervisor.js";

interface FakeProcess extends PtyProcess {
  emitData(data: string): void;
  emitExit(exitCode?: number, signal?: number): void;
  writes: string[];
}

const createFakeProcess = (): FakeProcess => {
  const dataHandlers = new Set<(data: string) => void>();
  const exitHandlers = new Set<(event: { exitCode: number; signal: number }) => void>();
  return {
    writes: [],
    write(data: string) {
      this.writes.push(data);
      const ready = data.match(/(__PIARIUM_READY_[0-9a-f]+__)/)?.[1];
      if (ready) {
        queueMicrotask(() => { for (const handler of dataHandlers) handler(`${ready}\n`); });
        return;
      }
      const token = data.match(/__PIARIUM_SENTINEL_([0-9a-f]+):B/)?.[1];
      if (!token) return;
      queueMicrotask(() => { for (const handler of dataHandlers) handler(`__PIARIUM_SENTINEL_${token}:B\nprompt>`); });
    },
    resize() {},
    kill() {
      for (const handler of exitHandlers) handler({ exitCode: 0, signal: 0 });
    },
    onData(handler) {
      dataHandlers.add(handler);
      return { dispose: () => dataHandlers.delete(handler) };
    },
    onExit(handler) {
      exitHandlers.add(handler);
      return { dispose: () => exitHandlers.delete(handler) };
    },
    emitData(data: string) {
      for (const handler of dataHandlers) handler(data);
    },
    emitExit(exitCode = 0, signal = 0) {
      for (const handler of exitHandlers) handler({ exitCode, signal });
    },
  };
};

describe("harness terminal runtime bridge", () => {
  const runtimes: Array<ReturnType<typeof createIsolatedTerminalSessionApi>> = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("lets the user attach and write to the same background process the agent observes", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "harness-term-"));
    dirs.push(workspace);
    const processes: FakeProcess[] = [];
    const ptyProvider: PtyProvider = {
      backend: "fake-pty",
      spawn: () => {
        const process = createFakeProcess();
        processes.push(process);
        return process;
      },
    };
    const runtime = createIsolatedTerminalSessionApi({
      loadPtyProvider: async () => ptyProvider,
      searchPathFor: () => "/bin/sh",
      isExecutable: () => true,
    });
    runtimes.push(runtime);
    const outputStore = createOutputStore();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: ["-l"], env: {} },
      outputStore,
      sessionId: "bridge",
      cwd: workspace,
      createTerminalSession: (input) => runtime.createTerminalSession(input),
    });
    try {
      const started = await supervisor.exec("read line", { waitMs: 5 });
      expect(started).toMatchObject({ kind: "background", id: "sh_1" });
      expect(processes).toHaveLength(1);
      expect(runtime.inspectSession("sh_1")).toMatchObject({
        owner: "harness",
        retainWhenDetached: true,
        status: "running",
      });

      const attached = runtime.attachTerminalSession("sh_1");
      expect(attached?.id).toBe("sh_1");
      const view: string[] = [];
      attached?.onData((data) => { view.push(data); });

      const later = "user typed this\n";
      attached?.write(later);
      expect(processes[0]?.writes).toContain(later);
      expect(await supervisor.write("sh_1", "agent-input")).toBe(true);
      expect(processes[0]?.writes).toContain("agent-input");

      processes[0]?.emitData("user typed this\n");
      await new Promise((resolve) => setTimeout(resolve, 10));
      const observed = await supervisor.read("sh_1");
      expect(observed.text).toContain("user typed this");
      expect(observed.running).toBe(true);
      expect(view.join("")).toContain("user typed this");

      const next = await supervisor.exec("echo later", { waitMs: 50 });
      expect(processes).toHaveLength(2);
      expect(runtime.inspectSession("sh_1")?.status).toBe("running");
      expect(next.kind === "completed" || next.kind === "background").toBe(true);

      processes[0]?.emitExit(0);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await expect(supervisor.read("sh_1")).resolves.toMatchObject({ running: false, exitCode: 0 });
    } finally {
      await supervisor.dispose();
      outputStore.dispose();
    }
  });
});
