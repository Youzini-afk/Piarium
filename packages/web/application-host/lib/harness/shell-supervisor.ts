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
    return { kind: "remote", command: "bash", args: ["-l"], env: {} };
  }

  if (setting === "powershell") {
    if (platform === "win32") {
      return { kind: "powershell", command: "powershell.exe", args: ["-NoProfile", "-Command", "-"], env: {} };
    }
    return { unavailable: { reason: "PowerShell is only available on Windows", hint: "Use auto or bash setting on this platform." } };
  }

  if (setting === "wsl") {
    if (platform !== "win32") return { unavailable: { reason: "WSL is only available on Windows", hint: "Use auto or bash setting on this platform." } };
    const distro = discovered.wslDistros?.[0];
    if (!distro) return { unavailable: { reason: "No WSL distribution found", hint: "Install WSL from https://learn.microsoft.com/en-us/windows/wsl/install" } };
    return { kind: "wsl", command: "wsl.exe", args: ["-d", distro, "--", "bash", "-l"], env: {}, distro };
  }

  if (setting === "git-bash") {
    if (platform !== "win32") return { unavailable: { reason: "Git Bash is only available on Windows", hint: "Use auto or bash setting on this platform." } };
    if (!discovered.gitBashPath) return { unavailable: { reason: "Git for Windows not found", hint: 'Install it from https://git-scm.com/download/win or set harness.shell to "powershell".' } };
    return { kind: "git-bash", command: discovered.gitBashPath, args: ["-l"], env: { MSYS_NO_PATHCONV: "1" } };
  }

  // Auto detection
  if (platform === "win32") {
    const wslMatch = workspaceRoot.match(WSL_PATH_PATTERN);
    if (wslMatch && wslMatch[2]) {
      const distro = wslMatch[2];
      return { kind: "wsl", command: "wsl.exe", args: ["-d", distro, "--", "bash", "-l"], env: {}, distro };
    }
    if (discovered.gitBashPath) {
      return { kind: "git-bash", command: discovered.gitBashPath, args: ["-l"], env: { MSYS_NO_PATHCONV: "1" } };
    }
    return { unavailable: { reason: "Git for Windows not found", hint: 'Install it from https://git-scm.com/download/win or set harness.shell to "powershell".' } };
  }

  if (discovered.hasBash !== false) {
    return { kind: "bash", command: "bash", args: ["-l"], env: {} };
  }

  return { unavailable: { reason: "No suitable shell found", hint: "Install bash or set harness.shell explicitly." } };
}

const CSI_PATTERN = /\x1b\[[0-?]*[ -\/]*[@-~]/g;
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;
const ESC_PATTERN = /\x1b./g;

export function stripControlSequences(text: string): string {
  return text.replace(OSC_PATTERN, "").replace(CSI_PATTERN, "").replace(ESC_PATTERN, "");
}

const SENTINEL = "__PIARIUM_SENTINEL_";

function buildCommandWrapper(command: string, token: string): string {
  return `echo '${SENTINEL}${token}:B'; { ${command}; }; __ec=$?; echo '${SENTINEL}${token}:C:'"$PWD"; echo '${SENTINEL}${token}:E:'"$__ec"`;
}

// ── PTY Provider ────────────────────────────────────────────────────

interface PtyProcess {
  kill(signal?: NodeJS.Signals): void;
  onData(handler: (data: string) => void): { dispose?(): void };
  onExit(handler: (event: { exitCode: number; signal: number }) => void): { dispose?(): void };
  pid?: number;
  resize(cols: number, rows: number): void;
  write(data: string): void;
}

interface PtyProvider {
  backend: string;
  spawn(executable: string, args: string[], options: Record<string, unknown>): PtyProcess;
}

async function loadPtyProvider(): Promise<PtyProvider> {
  if ("Bun" in globalThis) {
    try {
      const pty = await import("bun-pty");
      return { spawn: pty.spawn as PtyProvider["spawn"], backend: "bun-pty" };
    } catch { /* fall through */ }
  }
  const pty = await import("node-pty");
  return { spawn: pty.spawn as PtyProvider["spawn"], backend: "node-pty" };
}

// ── Shell Supervisor (PTY-based) ────────────────────────────────────

export interface ShellSupervisorOptions {
  interpreter: ShellInterpreter;
  outputStore: OutputStore;
  sessionId: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  registerWriter?: () => Promise<{ close: () => Promise<void> } | null>;
}

interface BackgroundShell {
  id: string;
  token: string;
  output: string;
  cwd: string;
  exited: boolean;
  exitCode: number | null;
  writer: { close: () => Promise<void> } | null;
}

export function createShellSupervisor(deps: ShellSupervisorOptions) {
  const { interpreter, outputStore, sessionId } = deps;
  const cols = deps.cols ?? 120;
  const rows = deps.rows ?? 40;
  const baseEnv: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    PAGER: "cat",
    GIT_PAGER: "cat",
    NO_COLOR: "1",
    PYTHONUNBUFFERED: "1",
    TERM: "xterm-256color",
    ...deps.env,
    ...interpreter.env,
  };
  if (process.platform === "linux") baseEnv.DEBIAN_FRONTEND = "noninteractive";

  const backgroundShells = new Map<string, BackgroundShell>();
  let shellCounter = 0;
  let disposed = false;
  let ptyProcess: PtyProcess | null = null;
  let ptyProvider: PtyProvider | null = null;
  let outputBuffer = "";
  let shellReady = false;
  let shellReadyResolve: (() => void) | null = null;
  const shellReadyPromise = new Promise<void>((resolve) => { shellReadyResolve = resolve; });

  // Pending command state
  interface PendingCommand {
    token: string;
    resolve: (result: ShellExecResult) => void;
    timeout: ReturnType<typeof setTimeout>;
    cwd: string;
    writer: { close: () => Promise<void> } | null;
    startedAt: number;
  }
  let pendingCommand: PendingCommand | null = null;

  const ensureShell = async (): Promise<void> => {
    if (shellReady) return;
    if (!ptyProvider) ptyProvider = await loadPtyProvider();
    if (ptyProcess) return shellReadyPromise;

    return new Promise<void>((resolve, reject) => {
      if (!ptyProvider) { reject(new Error("PTY provider not loaded")); return; }
      try {
        ptyProcess = ptyProvider.spawn(interpreter.command, interpreter.args, {
          cols,
          rows,
          cwd: deps.env?.PWD ?? process.cwd(),
          env: { ...process.env, ...baseEnv } as Record<string, string>,
          windowsHide: true,
        });
      } catch (error) {
        reject(error);
        return;
      }

      // Wait for initial prompt by sending a unique echo command
      const initToken = randomBytes(8).toString("hex");
      const initMarker = `__PIARIUM_READY_${initToken}__`;
      let initBuffer = "";

      ptyProcess.onData((data: string) => {
        // Route to pending command or init
        if (pendingCommand) {
          outputBuffer += data;
          parsePendingOutput();
        } else {
          initBuffer += data;
          // Strip control sequences for marker detection
          const cleaned = stripControlSequences(initBuffer);
          if (cleaned.includes(initMarker)) {
            shellReady = true;
            shellReadyResolve?.();
            resolve();
          }
        }
      });

      ptyProcess.onExit((event) => {
        if (!shellReady) {
          reject(new Error(`Shell exited before ready (code ${event.exitCode})`));
          return;
        }
        // Shell exited unexpectedly
        if (pendingCommand) {
          clearTimeout(pendingCommand.timeout);
          pendingCommand.resolve({
            kind: "completed",
            exitCode: event.exitCode,
            durationMs: Date.now() - pendingCommand.startedAt,
            cwd: pendingCommand.cwd,
            stdout: stripControlSequences(outputBuffer),
            stderr: "",
            handle: null,
            shown: null,
          });
          pendingCommand = null;
        }
      });

      // Send init marker to detect shell readiness
      ptyProcess.write(`echo ${initMarker}\n`);
    });
  };

  const parsePendingOutput = (): void => {
    if (!pendingCommand) return;
    const { token } = pendingCommand;
    const sentinelPattern = new RegExp(`${SENTINEL}${token}:(B|C:[^\\n]*|E:\\d+)`, "g");
    let match: RegExpExecArray | null;
    sentinelPattern.lastIndex = 0;
    while ((match = sentinelPattern.exec(outputBuffer)) !== null) {
      const sentinelLine = match[1];
      if (sentinelLine === "B") {
        // Begin sentinel — remove everything up to and including it
        outputBuffer = outputBuffer.slice(match.index + match[0].length);
        sentinelPattern.lastIndex = 0;
      } else if (sentinelLine?.startsWith("C:")) {
        pendingCommand.cwd = sentinelLine.slice(2).trim();
        outputBuffer = outputBuffer.slice(0, match.index) + outputBuffer.slice(match.index + match[0].length);
        sentinelPattern.lastIndex = 0;
      } else if (sentinelLine?.startsWith("E:")) {
        const exitCode = parseInt(sentinelLine.slice(2), 10);
        // Remove the sentinel from output
        outputBuffer = outputBuffer.slice(0, match.index) + outputBuffer.slice(match.index + match[0].length);
        completeCommand(exitCode);
        return;
      }
    }
  };

  const completeCommand = (exitCode: number): void => {
    if (!pendingCommand) return;
    clearTimeout(pendingCommand.timeout);
    const cmd = pendingCommand;
    pendingCommand = null;

    const cleanedOutput = stripControlSequences(outputBuffer);
    outputBuffer = "";

    // Release writer
    void cmd.writer?.close();

    let handle: string | null = null;
    let shown: { head: number; tail: number; total: number } | null = null;
    const totalBytes = Buffer.byteLength(cleanedOutput, "utf8");
    if (totalBytes > 32768) {
      const stored = outputStore.store(sessionId, cleanedOutput, "bash");
      handle = stored.handle;
      shown = { head: 0, tail: 0, total: stored.total };
    }

    cmd.resolve({
      kind: "completed",
      exitCode,
      durationMs: Date.now() - cmd.startedAt,
      cwd: cmd.cwd,
      stdout: cleanedOutput,
      stderr: "",
      handle,
      shown,
    });
  };

  const exec = async (command: string, options: { cwd?: string; waitMs: number }): Promise<ShellExecResult> => {
    if (disposed) return { kind: "spawn-failed", reason: "disposed", interpreter: interpreter.command, hint: "Shell supervisor has been disposed" };
    if (pendingCommand) throw new Error("Another command is already running");

    await ensureShell();
    if (!ptyProcess) return { kind: "spawn-failed", reason: "no-shell", interpreter: interpreter.command, hint: "Shell not initialized" };

    const token = randomBytes(8).toString("hex");
    const wrapped = buildCommandWrapper(command, token);
    const cwd = options.cwd ?? process.cwd();

    // Register writer for the duration of command execution
    const writer = deps.registerWriter ? await deps.registerWriter() : null;

    return new Promise<ShellExecResult>((resolvePromise) => {
      outputBuffer = "";
      const timeout = setTimeout(() => {
        // Background this command
        const id = `sh_${++shellCounter}`;
        const bgShell: BackgroundShell = {
          id,
          token,
          output: outputBuffer,
          cwd: pendingCommand?.cwd ?? cwd,
          exited: false,
          exitCode: null,
          writer,
        };
        backgroundShells.set(id, bgShell);
        pendingCommand = null;
        outputBuffer = "";

        const cleanedOutput = stripControlSequences(bgShell.output);
        resolvePromise({
          kind: "background",
          id,
          waitedMs: options.waitMs,
          cwd: bgShell.cwd,
          outputSoFar: cleanedOutput,
        });
      }, options.waitMs);

      pendingCommand = {
        token,
        resolve: resolvePromise,
        timeout,
        cwd,
        writer,
        startedAt: Date.now(),
      };

      // If cwd is different from current, cd first
      if (options.cwd) {
        ptyProcess.write(`cd ${JSON.stringify(options.cwd)} && ${wrapped}\n`);
      } else {
        ptyProcess.write(`${wrapped}\n`);
      }
    });
  };

  const read = async (id: string, offset: number = 0, length: number = 32768): Promise<OutputSlice & { running: boolean; exitCode?: number }> => {
    // Check background shells
    const bg = backgroundShells.get(id);
    if (bg) {
      const text = stripControlSequences(bg.output).slice(offset, offset + length);
      return {
        text,
        offset,
        length: text.length,
        total: Buffer.byteLength(bg.output, "utf8"),
        running: !bg.exited,
        ...(bg.exitCode !== null ? { exitCode: bg.exitCode } : {}),
      };
    }
    // Check output store (out_ handles)
    const slice = outputStore.read(sessionId, id, offset, length);
    if (slice) return { ...slice, running: false };
    throw new Error(`Shell not found: ${id}`);
  };

  const write = async (id: string, text: string): Promise<boolean> => {
    const bg = backgroundShells.get(id);
    if (bg && ptyProcess) {
      ptyProcess.write(text);
      return true;
    }
    return false;
  };

  const kill = async (id: string): Promise<boolean> => {
    const bg = backgroundShells.get(id);
    if (!bg) return false;
    // Send Ctrl+C to the PTY
    if (ptyProcess) ptyProcess.write("\x03");
    bg.exited = true;
    void bg.writer?.close();
    return true;
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    if (pendingCommand) {
      clearTimeout(pendingCommand.timeout);
      void pendingCommand.writer?.close();
      pendingCommand = null;
    }
    for (const bg of backgroundShells.values()) {
      void bg.writer?.close();
    }
    backgroundShells.clear();
    if (ptyProcess) {
      try { ptyProcess.kill("SIGTERM"); } catch { /* already exited */ }
      ptyProcess = null;
    }
  };

  return { exec, read, write, kill, dispose };
}
