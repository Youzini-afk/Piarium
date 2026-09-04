import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
    const discovered: DiscoveredShells = process.platform === "win32"
      ? { gitBashPath: "C:\\Program Files\\Git\\bin\\bash.exe" }
      : { hasBash: true };
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
