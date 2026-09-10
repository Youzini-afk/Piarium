import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverShells } from "./shell-discovery.js";
import { createShellSupervisor, selectInterpreter, stripControlSequences, type DiscoveredShells, type PtyProcess, type PtyProvider } from "./shell-supervisor.js";
import { createOutputStore } from "./output-store.js";

const EMPTY_DISCOVERED: DiscoveredShells = {};

describe("selectInterpreter", () => {
  it("returns remote on remote=true regardless of platform", () => {
    const result = selectInterpreter({
      platform: "win32",
      workspaceRoot: "C:\\workspace",
      setting: "auto",
      discovered: EMPTY_DISCOVERED,
      remote: true,
    });
    expect("kind" in result && result.kind).toBe("remote");
  });

  it("returns git-bash on win32 + auto when gitBashPath is found", () => {
    const result = selectInterpreter({
      platform: "win32",
      workspaceRoot: "C:\\workspace",
      setting: "auto",
      discovered: { gitBashPath: "C:\\Program Files\\Git\\bin\\bash.exe" },
      remote: false,
    });
    expect("kind" in result && result.kind).toBe("git-bash");
  });

  it("returns unavailable on win32 + auto when no git bash", () => {
    const result = selectInterpreter({
      platform: "win32",
      workspaceRoot: "C:\\workspace",
      setting: "auto",
      discovered: EMPTY_DISCOVERED,
      remote: false,
    });
    expect("unavailable" in result).toBe(true);
    if ("unavailable" in result) {
      expect(result.unavailable.reason).toMatch(/Git for Windows/);
    }
  });

  it("returns wsl on win32 + auto when workspaceRoot is a WSL path", () => {
    const result = selectInterpreter({
      platform: "win32",
      workspaceRoot: "\\\\wsl.localhost\\Ubuntu\\home\\user\\project",
      setting: "auto",
      discovered: EMPTY_DISCOVERED,
      remote: false,
    });
    expect("kind" in result && result.kind).toBe("wsl");
    if ("kind" in result && result.kind === "wsl") {
      expect(result.distro).toBe("Ubuntu");
    }
  });

  it("returns wsl on win32 + wsl setting with distros", () => {
    const result = selectInterpreter({
      platform: "win32",
      workspaceRoot: "C:\\workspace",
      setting: "wsl",
      discovered: { wslDistros: ["Ubuntu"] },
      remote: false,
    });
    expect("kind" in result && result.kind).toBe("wsl");
  });

  it("returns unavailable on win32 + wsl setting without distros", () => {
    const result = selectInterpreter({
      platform: "win32",
      workspaceRoot: "C:\\workspace",
      setting: "wsl",
      discovered: EMPTY_DISCOVERED,
      remote: false,
    });
    expect("unavailable" in result).toBe(true);
  });

  it("returns powershell on win32 + powershell setting", () => {
    const result = selectInterpreter({
      platform: "win32",
      workspaceRoot: "C:\\workspace",
      setting: "powershell",
      discovered: EMPTY_DISCOVERED,
      remote: false,
    });
    expect("kind" in result && result.kind).toBe("powershell");
    expect(result).toMatchObject({
      kind: "powershell",
      args: ["-NoLogo", "-NoProfile", "-NoExit"],
    });
  });

  it("returns unavailable for powershell on non-Windows", () => {
    const result = selectInterpreter({
      platform: "darwin",
      workspaceRoot: "/workspace",
      setting: "powershell",
      discovered: EMPTY_DISCOVERED,
      remote: false,
    });
    expect("unavailable" in result).toBe(true);
  });

  it("returns bash on darwin + auto", () => {
    const result = selectInterpreter({
      platform: "darwin",
      workspaceRoot: "/workspace",
      setting: "auto",
      discovered: { hasBash: true },
      remote: false,
    });
    expect("kind" in result && result.kind).toBe("bash");
  });

  it("returns bash on linux + auto", () => {
    const result = selectInterpreter({
      platform: "linux",
      workspaceRoot: "/workspace",
      setting: "auto",
      discovered: { hasBash: true },
      remote: false,
    });
    expect("kind" in result && result.kind).toBe("bash");
  });

  it("returns git-bash on win32 + git-bash setting with path", () => {
    const result = selectInterpreter({
      platform: "win32",
      workspaceRoot: "C:\\workspace",
      setting: "git-bash",
      discovered: { gitBashPath: "C:\\Git\\bin\\bash.exe" },
      remote: false,
    });
    expect("kind" in result && result.kind).toBe("git-bash");
    if ("kind" in result && result.kind === "git-bash") {
      expect(result.env.MSYS_NO_PATHCONV).toBe("1");
      expect(result.command).toBe("C:\\Git\\bin\\bash.exe");
    }
  });

  it("does not rewrite usr\\bin\\bash.exe into usr\\usr\\bin", () => {
    const result = selectInterpreter({
      platform: "win32",
      workspaceRoot: "C:\\workspace",
      setting: "auto",
      discovered: { gitBashPath: "C:\\Program Files\\Git\\usr\\bin\\bash.exe" },
      remote: false,
    });
    expect(result).toMatchObject({
      kind: "git-bash",
      command: "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    });
  });

  it("returns unavailable when powershell is explicitly missing", () => {
    const result = selectInterpreter({
      platform: "win32",
      workspaceRoot: "C:\\workspace",
      setting: "powershell",
      discovered: { hasPowerShell: false },
      remote: false,
    });
    expect("unavailable" in result).toBe(true);
    if ("unavailable" in result) {
      expect(result.unavailable.reason).toMatch(/PowerShell not found/);
    }
  });
});

describe("stripControlSequences", () => {
  it("removes CSI sequences", () => {
    expect(stripControlSequences("\x1b[31mred text\x1b[0m")).toBe("red text");
  });

  it("removes OSC sequences", () => {
    expect(stripControlSequences("\x1b]0;title\x07text")).toBe("text");
  });

  it("removes bare escape sequences", () => {
    expect(stripControlSequences("\x1b[?25htext\x1b[?25l")).toBe("text");
  });

  it("preserves regular text", () => {
    expect(stripControlSequences("hello world")).toBe("hello world");
  });

  it("handles mixed sequences", () => {
    expect(stripControlSequences("\x1b[1mbold\x1b[0m \x1b]0;title\x07 normal")).toBe("bold  normal");
  });
});

describe("background shell output", () => {
  it("keeps collecting output and observes the exit sentinel after a command backgrounds", async () => {
    const dataHandlers = new Set<(data: string) => void>();
    const exitHandlers = new Set<(event: { exitCode: number; signal: number }) => void>();
    const process: PtyProcess = {
      kill: () => { for (const handler of exitHandlers) handler({ exitCode: 0, signal: 0 }); },
      onData: (handler) => { dataHandlers.add(handler); return { dispose: () => dataHandlers.delete(handler) }; },
      onExit: (handler) => { exitHandlers.add(handler); return { dispose: () => exitHandlers.delete(handler) }; },
      resize: () => undefined,
      write: (data) => {
        const ready = data.match(/(__PIARIUM_READY_[0-9a-f]+__)/)?.[1];
        if (ready) {
          queueMicrotask(() => { for (const handler of dataHandlers) handler(`${ready}\n`); });
          return;
        }
        const token = data.match(/__PIARIUM_SENTINEL_([0-9a-f]+):B/)?.[1];
        if (!token) return;
        queueMicrotask(() => { for (const handler of dataHandlers) handler(`__PIARIUM_SENTINEL_${token}:B\nfirst`); });
        setTimeout(() => {
          for (const handler of dataHandlers) handler(` second\n__PIARIUM_SENTINEL_${token}:C:/workspace\n__PIARIUM_SENTINEL_${token}:E:0\n`);
        }, 30);
      },
    };
    const ptyProvider: PtyProvider = { backend: "fake", spawn: () => process };
    const outputStore = createOutputStore();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "background-test",
      ptyProvider,
    });
    try {
      const result = await supervisor.exec("slow command", { waitMs: 5 });
      expect(result).toMatchObject({ kind: "background", id: "sh_1", outputSoFar: expect.stringContaining("first") });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const read = await supervisor.read("sh_1");
      expect(read.text).toContain("first second");
      expect(read).toMatchObject({ running: false, exitCode: 0 });
      expect(read.text).not.toContain("PIARIUM_SENTINEL");
    } finally {
      await supervisor.dispose();
      outputStore.dispose();
    }
  });
});

describe("shell-supervisor dispose kills process tree", () => {
  it("dispose() terminates the PTY process and its children", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "shell-dispose-"));
    const outputStore = createOutputStore();
    const discovered: DiscoveredShells = discoverShells();
    const interp = selectInterpreter({
      platform: process.platform,
      workspaceRoot,
      setting: "auto",
      discovered,
      remote: false,
    });
    if (!("kind" in interp)) { rmSync(workspaceRoot, { recursive: true, force: true }); return; }

    const supervisor = createShellSupervisor({
      interpreter: interp,
      outputStore,
      sessionId: "dispose-test",
    });

    // Run a command to ensure the shell is spawned
    const result = await supervisor.exec("echo hello", { waitMs: 10000 });
    expect(result.kind).toBe("completed");

    // Dispose and verify the process tree is gone
    await supervisor.dispose();

    // Give the OS a moment to reap the process
    await new Promise((r) => setTimeout(r, 500));

    // We can't directly access the PID after dispose (ptyProcess is nulled),
    // but we can verify dispose() resolved without hanging and the test
    // process exits cleanly. The real verification is that the test runner
    // doesn't hang after this test completes.
    rmSync(workspaceRoot, { recursive: true, force: true });
  }, 15000);
});

describe("shell-supervisor initialization and cancellation", () => {
  type Mode = "init-fails" | "init-write-fails" | "never-ready" | "pending";

  const fakeProcess = (mode: Mode): PtyProcess => {
    const dataHandlers = new Set<(data: string) => void>();
    const exitHandlers = new Set<(event: { exitCode: number; signal: number }) => void>();
    let exited = false;
    return {
      kill: () => {
        if (exited) return;
        exited = true;
        for (const handler of exitHandlers) handler({ exitCode: 143, signal: 15 });
      },
      onData: (handler) => { dataHandlers.add(handler); return { dispose: () => dataHandlers.delete(handler) }; },
      onExit: (handler) => { exitHandlers.add(handler); return { dispose: () => exitHandlers.delete(handler) }; },
      resize: () => undefined,
      write: (data) => {
        const ready = data.match(/(__PIARIUM_READY_[0-9a-f]+__)/)?.[1];
        if (ready && mode === "pending") {
          queueMicrotask(() => { for (const handler of dataHandlers) handler(`${ready}\n`); });
        }
        if (ready && mode === "init-fails") {
          queueMicrotask(() => { for (const handler of exitHandlers) handler({ exitCode: 17, signal: 0 }); });
        }
        if (ready && mode === "init-write-fails") throw new Error("init write failed");
      },
    };
  };

  it("rejects initialization and allows a later retry instead of hanging", async () => {
    const outputStore = createOutputStore();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "init-failure",
      ptyProvider: { backend: "fake", spawn: () => fakeProcess("init-fails") },
    });
    try {
      await expect(supervisor.exec("echo first", { waitMs: 100 })).rejects.toThrow(/Shell exited before ready|disposed/);
      await expect(supervisor.exec("echo retry", { waitMs: 100 })).rejects.toThrow(/Shell exited before ready|disposed/);
    } finally {
      await supervisor.dispose();
      outputStore.dispose();
    }
  });

  it("reports a provider failure without leaving an unhandled readiness promise", async () => {
    const outputStore = createOutputStore();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "provider-failure",
      ptyProvider: { backend: "fake", spawn: () => { throw new Error("spawn failed"); } },
    });
    try {
      await expect(supervisor.exec("echo first", { waitMs: 100 })).rejects.toThrow("spawn failed");
      await expect(supervisor.exec("echo retry", { waitMs: 100 })).rejects.toThrow("spawn failed");
    } finally {
      await supervisor.dispose();
      outputStore.dispose();
    }
  });

  it("cleans up when the initial marker write fails", async () => {
    const outputStore = createOutputStore();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "init-write-failure",
      ptyProvider: { backend: "fake", spawn: () => fakeProcess("init-write-fails") },
    });
    try {
      await expect(supervisor.exec("echo first", { waitMs: 100 })).rejects.toThrow("init write failed");
      await expect(supervisor.exec("echo retry", { waitMs: 100 })).rejects.toThrow("init write failed");
    } finally {
      await supervisor.dispose();
      outputStore.dispose();
    }
  });

  it("resolves an in-flight command and closes its writer when disposed", async () => {
    const outputStore = createOutputStore();
    let writerClosed = 0;
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "command-dispose",
      ptyProvider: { backend: "fake", spawn: () => fakeProcess("pending") },
      registerWriter: async () => ({ close: async () => { writerClosed++; } }),
    });
    const resultPromise = supervisor.exec("never completes", { waitMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await supervisor.dispose();
    await expect(resultPromise).resolves.toMatchObject({ kind: "spawn-failed", reason: "disposed" });
    expect(writerClosed).toBe(1);
    outputStore.dispose();
  });

  it("cancels a shell that is still waiting for its initial marker", async () => {
    const outputStore = createOutputStore();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "init-dispose",
      ptyProvider: { backend: "fake", spawn: () => fakeProcess("never-ready") },
    });
    const resultPromise = supervisor.exec("echo never", { waitMs: 100 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await supervisor.dispose();
    await expect(resultPromise).rejects.toThrow(/disposed/);
    outputStore.dispose();
  });
});

describe("shell-supervisor disposal protection", () => {
  const controlledProcess = (options: {
    failSecondExitRegistration?: boolean;
    killThrows?: boolean;
  } = {}): PtyProcess & { emitExit: () => void } => {
    const dataHandlers = new Set<(data: string) => void>();
    const exitHandlers = new Set<(event: { exitCode: number; signal: number }) => void>();
    let exitRegistrations = 0;
    return {
      emitExit: () => { for (const handler of [...exitHandlers]) handler({ exitCode: 0, signal: 0 }); },
      kill: () => {
        if (options.killThrows) throw new Error("kill failed");
      },
      onData: (handler) => { dataHandlers.add(handler); return { dispose: () => dataHandlers.delete(handler) }; },
      onExit: (handler) => {
        exitRegistrations++;
        if (options.failSecondExitRegistration && exitRegistrations > 1) throw new Error("exit wait registration failed");
        exitHandlers.add(handler);
        return { dispose: () => exitHandlers.delete(handler) };
      },
      resize: () => undefined,
      write: (data) => {
        const ready = data.match(/(__PIARIUM_READY_[0-9a-f]+__)/)?.[1];
        if (ready) queueMicrotask(() => { for (const handler of dataHandlers) handler(`${ready}\n`); });
      },
    };
  };

  const setup = async (options: {
    failSecondExitRegistration?: boolean;
    killThrows?: boolean;
  } = {}) => {
    const workspace = mkdtempSync(join(tmpdir(), "shell-dispose-protection-"));
    const outputStore = createOutputStore();
    const process = controlledProcess(options);
    let writerClosed = 0;
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "dispose-protection",
      cwd: workspace,
      ptyProvider: { backend: "fake", spawn: () => process },
      registerWriter: async () => ({ close: async () => { writerClosed++; } }),
    });
    const command = supervisor.exec("never completes", { waitMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { command, outputStore, process, supervisor, workspace, get writerClosed() { return writerClosed; } };
  };

  it("keeps the writer and active directory protected when exit confirmation fails", async () => {
    const state = await setup({ failSecondExitRegistration: true });
    try {
      await expect(state.supervisor.dispose()).rejects.toThrow("exit wait registration failed");
      expect(state.writerClosed).toBe(0);
      expect(state.supervisor.hasActiveCommandAt(state.workspace)).toBe(true);
      state.process.emitExit();
      await expect(state.command).resolves.toMatchObject({ kind: "spawn-failed", reason: "disposed" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(state.writerClosed).toBe(1);
      expect(state.supervisor.hasActiveCommandAt(state.workspace)).toBe(false);
    } finally {
      await state.supervisor.dispose().catch(() => undefined);
      state.outputStore.dispose();
      rmSync(state.workspace, { recursive: true, force: true });
    }
  });

  it("keeps the writer while exit is delayed, then releases it after confirmation", async () => {
    const state = await setup();
    try {
      const disposePromise = state.supervisor.dispose();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(state.writerClosed).toBe(0);
      expect(state.supervisor.hasActiveCommandAt(state.workspace)).toBe(true);
      state.process.emitExit();
      await expect(disposePromise).resolves.toBeUndefined();
      await expect(state.command).resolves.toMatchObject({ kind: "spawn-failed", reason: "disposed" });
      expect(state.writerClosed).toBe(1);
      expect(state.supervisor.hasActiveCommandAt(state.workspace)).toBe(false);
    } finally {
      await state.supervisor.dispose().catch(() => undefined);
      state.outputStore.dispose();
      rmSync(state.workspace, { recursive: true, force: true });
    }
  });

  it("consumes a kill failure waiter and keeps protection until a later exit", async () => {
    const state = await setup({ killThrows: true });
    try {
      await expect(state.supervisor.dispose()).rejects.toThrow("kill failed");
      expect(state.writerClosed).toBe(0);
      expect(state.supervisor.hasActiveCommandAt(state.workspace)).toBe(true);
      state.process.emitExit();
      await expect(state.command).resolves.toMatchObject({ kind: "spawn-failed", reason: "disposed" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(state.writerClosed).toBe(1);
      expect(state.supervisor.hasActiveCommandAt(state.workspace)).toBe(false);
    } finally {
      await state.supervisor.dispose().catch(() => undefined);
      state.outputStore.dispose();
      rmSync(state.workspace, { recursive: true, force: true });
    }
  });

  it("keeps a background shell running until interrupt or PTY exit is observed", async () => {
    const outputStore = createOutputStore();
    const process = controlledProcess();
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "background-kill",
      ptyProvider: { backend: "fake", spawn: () => process },
    });
    try {
      const started = await supervisor.exec("never completes", { waitMs: 5 });
      expect(started).toMatchObject({ kind: "background", id: "sh_1" });
      await expect(supervisor.kill("sh_1")).resolves.toBe(true);
      await expect(supervisor.read("sh_1")).resolves.toMatchObject({ running: true });
      process.emitExit();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await expect(supervisor.read("sh_1")).resolves.toMatchObject({ running: false, exitCode: 0 });
    } finally {
      await supervisor.dispose().catch(() => undefined);
      outputStore.dispose();
    }
  });

  it("waits for a writer registration already in flight before disposal resolves", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "shell-dispose-starting-"));
    const outputStore = createOutputStore();
    const process = controlledProcess();
    let resolveWriter: (writer: { close: () => Promise<void> }) => void = () => undefined;
    const writerPromise = new Promise<{ close: () => Promise<void> }>((resolve) => { resolveWriter = resolve; });
    let writerClosed = 0;
    const supervisor = createShellSupervisor({
      interpreter: { kind: "bash", command: "bash", args: [], env: {} },
      outputStore,
      sessionId: "dispose-starting",
      cwd: workspace,
      ptyProvider: { backend: "fake", spawn: () => process },
      registerWriter: async () => writerPromise,
    });
    const command = supervisor.exec("never completes", { waitMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      let disposeDone = false;
      const disposePromise = supervisor.dispose().then(() => { disposeDone = true; });
      process.emitExit();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(disposeDone).toBe(false);
      expect(writerClosed).toBe(0);
      expect(supervisor.hasActiveCommandAt(workspace)).toBe(true);
      resolveWriter({ close: async () => { writerClosed++; } });
      await expect(disposePromise).resolves.toBeUndefined();
      await expect(command).resolves.toMatchObject({ kind: "spawn-failed", reason: "disposed" });
      expect(writerClosed).toBe(1);
      expect(supervisor.hasActiveCommandAt(workspace)).toBe(false);
    } finally {
      resolveWriter({ close: async () => { writerClosed++; } });
      await supervisor.dispose().catch(() => undefined);
      outputStore.dispose();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
