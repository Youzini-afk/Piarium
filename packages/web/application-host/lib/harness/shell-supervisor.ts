import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { OutputSlice, ShellExecResult } from "@piarium/protocol";
import type { OutputStore } from "./output-store.js";

export type ShellInterpreterKind = "git-bash" | "bash" | "wsl" | "powershell" | "remote";

export interface ShellInterpreter {
  kind: ShellInterpreterKind;
  command: string;
  args: string[];
  env: Record<string, string>;
  distro?: string;
}

export interface DiscoveredShells {
  gitBashPath?: string;
  wslDistros?: string[];
  hasBash?: boolean;
  hasPowerShell?: boolean;
}

export interface SelectInterpreterInput {
  platform: NodeJS.Platform;
  workspaceRoot: string;
  setting: "auto" | "git-bash" | "powershell" | "wsl";
  discovered: DiscoveredShells;
  remote: boolean;
}

const WSL_PATH_PATTERN = /^\\\\wsl(\$|\.localhost)\\([^\\]+)/i;

export function selectInterpreter(input: SelectInterpreterInput): ShellInterpreter | { unavailable: { reason: string; hint: string } } {
  const { platform, workspaceRoot, setting, discovered, remote } = input;

  if (remote) {
    return {
      kind: "remote",
      command: "bash",
      args: ["-l"],
      env: {},
    };
  }

  // Explicit setting
  if (setting === "powershell") {
    if (platform === "win32") {
      return {
        kind: "powershell",
        command: "powershell.exe",
        args: ["-NoProfile", "-Command", "-"],
        env: {},
      };
    }
    return { unavailable: { reason: "PowerShell is only available on Windows", hint: "Use auto or bash setting on this platform." } };
  }

  if (setting === "wsl") {
    if (platform !== "win32") {
      return { unavailable: { reason: "WSL is only available on Windows", hint: "Use auto or bash setting on this platform." } };
    }
    const distro = discovered.wslDistros?.[0];
    if (!distro) {
      return { unavailable: { reason: "No WSL distribution found", hint: "Install WSL from https://learn.microsoft.com/en-us/windows/wsl/install" } };
    }
    return {
      kind: "wsl",
      command: "wsl.exe",
      args: ["-d", distro, "--", "bash", "-l"],
      env: {},
      distro,
    };
  }

  if (setting === "git-bash") {
    if (platform !== "win32") {
      return { unavailable: { reason: "Git Bash is only available on Windows", hint: "Use auto or bash setting on this platform." } };
    }
    if (!discovered.gitBashPath) {
      return { unavailable: { reason: "Git for Windows not found", hint: 'Install it from https://git-scm.com/download/win or set harness.shell to "powershell".' } };
    }
    return {
      kind: "git-bash",
      command: discovered.gitBashPath,
      args: ["-l"],
      env: { MSYS_NO_PATHCONV: "1" },
    };
  }

  // Auto detection
  if (platform === "win32") {
    // Check for WSL path
    const wslMatch = workspaceRoot.match(WSL_PATH_PATTERN);
    if (wslMatch && wslMatch[2]) {
      const distro = wslMatch[2];
      return {
        kind: "wsl",
        command: "wsl.exe",
        args: ["-d", distro, "--", "bash", "-l"],
        env: {},
        distro,
      };
    }
    // Default to git-bash on Windows
    if (discovered.gitBashPath) {
      return {
        kind: "git-bash",
        command: discovered.gitBashPath,
        args: ["-l"],
        env: { MSYS_NO_PATHCONV: "1" },
      };
    }
    return { unavailable: { reason: "Git for Windows not found", hint: 'Install it from https://git-scm.com/download/win or set harness.shell to "powershell".' } };
  }

  // Non-Windows: use bash
  if (discovered.hasBash !== false) {
    return {
      kind: "bash",
      command: "bash",
      args: ["-l"],
      env: {},
    };
  }

  return { unavailable: { reason: "No suitable shell found", hint: "Install bash or set harness.shell explicitly." } };
}

const CSI_PATTERN = /\x1b\[[0-?]*[ -\/]*[@-~]/g;
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;
const ESC_PATTERN = /\x1b./g;

export function stripControlSequences(text: string): string {
  return text
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESC_PATTERN, "");
}

const SENTINEL = "\x1f"; // ASCII 31

function buildCommandWrapper(command: string, token: string): string {
  return `printf '${SENTINEL}%s:B\\n' ${token}; { ${command}\n}; __ec=$?; printf '${SENTINEL}%s:C:%s\\n' ${token} "$PWD"; printf '${SENTINEL}%s:E:%d\\n' ${token} "$__ec"`;
}

interface BackgroundShell {
  id: string;
  process: ChildProcess;
  cwd: string;
  output: string;
  exitCode: number | null;
  exited: boolean;
  token: string;
  seenEnd: boolean;
}

export interface ShellSupervisorOptions {
  interpreter: ShellInterpreter;
  outputStore: OutputStore;
  sessionId: string;
  env?: Record<string, string>;
}

export function createShellSupervisor(deps: ShellSupervisorOptions) {
  const { interpreter, outputStore, sessionId } = deps;
  const baseEnv: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    PAGER: "cat",
    GIT_PAGER: "cat",
    NO_COLOR: "1",
    PYTHONUNBUFFERED: "1",
    ...deps.env,
    ...interpreter.env,
  };
  if (process.platform === "linux") baseEnv.DEBIAN_FRONTEND = "noninteractive";

  const backgroundShells = new Map<string, BackgroundShell>();
  let shellCounter = 0;
  let disposed = false;

  const exec = async (command: string, options: { cwd?: string; waitMs: number }): Promise<ShellExecResult> => {
    if (disposed) return { kind: "spawn-failed", reason: "disposed", interpreter: interpreter.command, hint: "Shell supervisor has been disposed" };

    const token = randomBytes(8).toString("hex");
    const wrapped = buildCommandWrapper(command, token);
    const cwd = options.cwd ?? process.cwd();
    const child = spawn(interpreter.command, [...interpreter.args, "-c", wrapped], {
      cwd,
      env: { ...process.env, ...baseEnv } as Record<string, string>,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let outputBuffer = "";
    let seenBegin = false;
    let seenEnd = false;
    let exitCode: number | null = null;
    let recordedCwd = cwd;

    const sentinelPattern = new RegExp(`${SENTINEL}${token}:(B|C:[^\\n]*|E:\\d+)\\n?`, "g");

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      outputBuffer += text;
      // Parse sentinels
      let match: RegExpExecArray | null;
      sentinelPattern.lastIndex = 0;
      while ((match = sentinelPattern.exec(outputBuffer)) !== null) {
        const sentinelLine = match[1];
        if (sentinelLine === "B") {
          seenBegin = true;
          // Remove everything up to and including the B sentinel
          outputBuffer = outputBuffer.slice(match.index + match[0].length);
          sentinelPattern.lastIndex = 0;
        } else if (sentinelLine?.startsWith("C:")) {
          recordedCwd = sentinelLine.slice(2).trim();
          outputBuffer = outputBuffer.slice(0, match.index) + outputBuffer.slice(match.index + match[0].length);
          sentinelPattern.lastIndex = 0;
        } else if (sentinelLine?.startsWith("E:")) {
          exitCode = parseInt(sentinelLine.slice(2), 10);
          seenEnd = true;
          outputBuffer = outputBuffer.slice(0, match.index) + outputBuffer.slice(match.index + match[0].length);
          sentinelPattern.lastIndex = 0;
        }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });

    const timeoutPromise = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), options.waitMs);
    });

    const exitPromise = new Promise<"exited">((resolve) => {
      child.on("exit", (code) => {
        exitCode = code ?? exitCode;
        resolve("exited");
      });
      child.on("error", () => resolve("exited"));
    });

    const result = await Promise.race([timeoutPromise, exitPromise]);

    if (result === "timeout" && !seenEnd) {
      // Background this shell
      const id = `sh_${++shellCounter}`;
      const bgShell: BackgroundShell = {
        id,
        process: child,
        cwd: recordedCwd,
        output: outputBuffer,
        exitCode: null,
        exited: false,
        token,
        seenEnd: false,
      };
      child.on("exit", (code) => {
        bgShell.exitCode = code;
        bgShell.exited = true;
      });
      backgroundShells.set(id, bgShell);

      const cleanedOutput = stripControlSequences(outputBuffer);
      return {
        kind: "background",
        id,
        waitedMs: options.waitMs,
        cwd: recordedCwd,
        outputSoFar: cleanedOutput,
      };
    }

    // Completed
    child.kill();
    const cleanedStdout = stripControlSequences(outputBuffer);
    const cleanedStderr = stripControlSequences(stderr);
    const fullOutput = cleanedStdout + (cleanedStderr ? `\n[stderr]\n${cleanedStderr}` : "");

    let handle: string | null = null;
    let shown: { head: number; tail: number; total: number } | null = null;
    const totalBytes = Buffer.byteLength(fullOutput, "utf8");
    if (totalBytes > 32768) {
      const stored = outputStore.store(sessionId, fullOutput, "bash");
      handle = stored.handle;
      shown = { head: 0, tail: 0, total: stored.total };
    }

    return {
      kind: "completed",
      exitCode: exitCode ?? 1,
      durationMs: options.waitMs, // Approximate
      cwd: recordedCwd,
      stdout: cleanedStdout,
      stderr: cleanedStderr,
      handle,
      shown,
    };
  };

  const read = async (id: string, offset: number = 0, length: number = 32768): Promise<OutputSlice & { running: boolean; exitCode?: number }> => {
    const bg = backgroundShells.get(id);
    if (!bg) {
      // Try output store (out_ handles)
      const slice = outputStore.read(sessionId, id, offset, length);
      if (slice) return { ...slice, running: false };
      throw new Error(`Shell not found: ${id}`);
    }
    const text = stripControlSequences(bg.output).slice(offset, offset + length);
    return {
      text,
      offset,
      length: text.length,
      total: Buffer.byteLength(bg.output, "utf8"),
      running: !bg.exited,
      ...(bg.exitCode !== null ? { exitCode: bg.exitCode } : {}),
    };
  };

  const write = async (id: string, text: string): Promise<boolean> => {
    const bg = backgroundShells.get(id);
    if (!bg) return false;
    bg.process.stdin?.write(text);
    return true;
  };

  const kill = async (id: string): Promise<boolean> => {
    const bg = backgroundShells.get(id);
    if (!bg) return false;
    try {
      bg.process.kill("SIGTERM");
    } catch {
      // Already exited
    }
    bg.exited = true;
    return true;
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    for (const bg of backgroundShells.values()) {
      try { bg.process.kill("SIGTERM"); } catch { /* already exited */ }
    }
    backgroundShells.clear();
  };

  return { exec, read, write, kill, dispose };
}
