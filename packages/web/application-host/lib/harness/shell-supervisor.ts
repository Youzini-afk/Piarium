import { randomBytes } from "node:crypto";
import path from "node:path";
import { sliceUtf8ByBytes, type OutputSlice, type ShellExecResult } from "@piarium/protocol";
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
    if (platform !== "win32") {
      return { unavailable: { reason: "PowerShell is only available on Windows", hint: "Use auto or bash setting on this platform." } };
    }
    if (discovered.hasPowerShell === false) {
      return { unavailable: { reason: "PowerShell not found", hint: "Install Windows PowerShell or set harness.shell to auto / git-bash." } };
    }
    // Keep a real interactive process attached to the PTY. `-Command -`
    // exits under ConPTY because stdin is not a redirected pipe.
    return { kind: "powershell", command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NoExit"], env: {} };
  }

  if (setting === "wsl") {
    if (platform !== "win32") return { unavailable: { reason: "WSL is only available on Windows", hint: "Use auto or bash setting on this platform." } };
    const distro = discovered.wslDistros?.[0];
    if (!distro) return { unavailable: { reason: "No WSL distribution found", hint: "Install WSL from https://learn.microsoft.com/en-us/windows/wsl/install" } };
    return { kind: "wsl", command: "wsl.exe", args: ["-d", distro, "--", "bash", "-l"], env: {}, distro };
  }

  if (setting === "git-bash") {
    if (platform !== "win32") return { unavailable: { reason: "Git Bash is only available on Windows", hint: "Use auto or bash setting on this platform." } };
    if (!discovered.gitBashPath) return { unavailable: { reason: "Git for Windows not found", hint: 'Install Git for Windows from https://git-scm.com/download/win, or set harness.shell to "powershell" if that interpreter is installed.' } };
    // Discovery records the executable to spawn. Prefer usr\bin\bash.exe there
    // so this path is not rewritten when only the bin\ launcher exists.
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
    return { unavailable: { reason: "Git for Windows not found", hint: 'Install Git for Windows from https://git-scm.com/download/win, or set harness.shell to "powershell" if that interpreter is installed.' } };
  }

  if (discovered.hasBash !== false) {
    return { kind: "bash", command: "bash", args: ["-l"], env: {} };
  }

  return { unavailable: { reason: "No suitable shell found", hint: "Install bash or set harness.shell explicitly." } };
}

// eslint-disable-next-line no-control-regex, no-useless-escape
const CSI_PATTERN = /\x1b\[[0-?]*[ -\/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const ESC_PATTERN = /\x1b./g;

export function stripControlSequences(text: string): string {
  return text.replace(OSC_PATTERN, "").replace(CSI_PATTERN, "").replace(ESC_PATTERN, "");
}

const SENTINEL = "__PIARIUM_SENTINEL_";

const quotePowerShell = (value: string): string => `'${value.replace(/'/g, "''")}'`;

function buildCommandWrapper(command: string, token: string, kind: ShellInterpreterKind): string {
  if (kind === "powershell") {
    const begin = quotePowerShell(`${SENTINEL}${token}:B`);
    const cwd = quotePowerShell(`${SENTINEL}${token}:C:`);
    const end = quotePowerShell(`${SENTINEL}${token}:E:`);
    return [
      `Write-Output ${begin}`,
      command,
      "$__piarium_success = $?",
      "$__piarium_exit = $LASTEXITCODE",
      "$__piarium_code = if ($__piarium_success) { 0 } elseif ($__piarium_exit -is [int] -and $__piarium_exit -ne 0) { [int]$__piarium_exit } else { 1 }",
      `Write-Output (${cwd} + (Get-Location).Path)`,
      `Write-Output (${end} + $__piarium_code)`,
    ].join("; ");
  }
  return `echo '${SENTINEL}${token}:B'; { ${command}; }; __ec=$?; echo '${SENTINEL}${token}:C:'"$PWD"; echo '${SENTINEL}${token}:E:'"$__ec"`;
}

// ── PTY Provider ────────────────────────────────────────────────────

export interface PtyProcess {
  kill(signal?: NodeJS.Signals): void;
  onData(handler: (data: string) => void): { dispose?(): void };
  onExit(handler: (event: { exitCode: number; signal: number }) => void): { dispose?(): void };
  pid?: number;
  resize(cols: number, rows: number): void;
  write(data: string): void;
}

export interface PtyProvider {
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
  cwd?: string;
  cols?: number;
  rows?: number;
  registerWriter?: () => Promise<{ close: () => Promise<void> } | null>;
  /** Deterministic test seam; production loads bun-pty or node-pty. */
  ptyProvider?: PtyProvider;
}

interface BackgroundShell {
  id: string;
  token: string;
  command: string;
  output: string;
  cwd: string;
  exited: boolean;
  exitCode: number | null;
  lastOutputAt: number | null;
  writer: { close: () => Promise<void> } | null;
}

export type ShellSupervisor = ReturnType<typeof createShellSupervisor>;

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
  let activeBackground: BackgroundShell | null = null;
  let shellCounter = 0;
  let disposed = false;
  let ptyProcess: PtyProcess | null = null;
  let ptyProvider: PtyProvider | null = deps.ptyProvider ?? null;
  let outputBuffer = "";
  let shellReady = false;
  let shellReadyPromise: Promise<void> | null = null;
  let shellReadyResolve: (() => void) | null = null;
  let shellReadyReject: ((error: unknown) => void) | null = null;
  // Track disposables from onData/onExit to clean up on dispose
  let dataDisposable: { dispose?(): void } | null = null;
  let exitDisposable: { dispose?(): void } | null = null;

  // Pending command state
  type ShellWriter = { close: () => Promise<void> };
  interface PendingCommand {
    token: string;
    resolve: (result: ShellExecResult) => void;
    timeout: ReturnType<typeof setTimeout>;
    cwd: string;
    writer: ShellWriter | null;
    startedAt: number;
  }
  let pendingCommand: PendingCommand | null = null;
  // A command can be between ensureShell()/registerWriter() and assigning
  // pendingCommand. Keep that interval exclusive as well.
  let commandStarting = false;
  let disposeRequested = false;
  let stopping = false;
  let stoppingDirectory: string | null = null;
  let stopped = false;
  let disposePromise: Promise<void> | null = null;
  let finalizingStop: Promise<boolean> | null = null;
  let commandStartPromise: Promise<void> | null = null;
  const startingWriters = new Set<ShellWriter>();

  const closeBackgroundWriter = (background: BackgroundShell): Promise<void> => {
    const writer = background.writer;
    background.writer = null;
    return writer?.close() ?? Promise.resolve();
  };

  const clearPtyHandlers = (): void => {
    try { dataDisposable?.dispose?.(); } catch { /* already disposed */ }
    try { exitDisposable?.dispose?.(); } catch { /* already disposed */ }
    dataDisposable = null;
    exitDisposable = null;
  };

  const closePendingWriterAfterStop = async (pending: PendingCommand): Promise<void> => {
    const writer = pending.writer;
    if (!writer) return;
    await writer.close();
    pending.writer = null;
  };

  const closeBackgroundWriterAfterStop = async (background: BackgroundShell): Promise<void> => {
    const writer = background.writer;
    if (!writer) return;
    await writer.close();
    background.writer = null;
  };

  /**
   * Release command state only after the PTY has emitted its exit event. A
   * rejected writer close leaves the entry visible so worktree reclamation
   * keeps its protection and a later disposal attempt can retry the close.
   */
  const finalizeStoppedResources = async (): Promise<boolean> => {
    if (finalizingStop) return finalizingStop;
    const work = (async (): Promise<boolean> => {
      // onExit can arrive while a command is still acquiring its writer.
      // Keep the stopping state until that setup has handed over its resources.
      if (commandStartPromise) await commandStartPromise;
      const pending = pendingCommand;
      const backgrounds = [...backgroundShells.values()];
      const starting = [...startingWriters];
      try {
        if (pending) await closePendingWriterAfterStop(pending);
        await Promise.all(backgrounds.map((background) => closeBackgroundWriterAfterStop(background)));
        await Promise.all(starting.map(async (writer) => {
          await writer.close();
          if (startingWriters.has(writer)) startingWriters.delete(writer);
        }));
      } catch {
        return false;
      }

      if (pendingCommand === pending && pending) {
        pendingCommand = null;
        pending.resolve({
          kind: "spawn-failed",
          reason: "disposed",
          interpreter: interpreter.command,
          hint: "Shell supervisor has been disposed",
        });
      }
      for (const background of backgrounds) {
        if (backgroundShells.get(background.id) === background) backgroundShells.delete(background.id);
      }
      if (backgrounds.includes(activeBackground as BackgroundShell)) activeBackground = null;
      stopping = false;
      stoppingDirectory = null;
      stopped = true;
      disposeRequested = false;
      return true;
    })().finally(() => {
      finalizingStop = null;
    });
    finalizingStop = work;
    return work;
  };

  const ensureShell = async (): Promise<void> => {
    if (disposed) throw new Error("Shell supervisor has been disposed");
    if (shellReady) return;
    if (!ptyProvider) ptyProvider = await loadPtyProvider();
    if (disposed) throw new Error("Shell supervisor has been disposed");
    if (ptyProcess) return shellReadyPromise ?? Promise.resolve();

    // PowerShell must receive an initial command on its command line. Sending
    // `-Command -` to a ConPTY is rejected as if stdin were not redirected;
    // `-NoExit -Command <marker>` leaves the interactive process alive and
    // gives us a deterministic readiness marker before any user command.
    const initToken = randomBytes(8).toString("hex");
    const initMarker = `__PIARIUM_READY_${initToken}__`;

    let resolveReady: () => void = () => undefined;
    let rejectReady: (error: unknown) => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    shellReadyPromise = ready;
    shellReadyResolve = resolveReady;
    shellReadyReject = rejectReady;

    try {
      if (!ptyProvider) {
        const error = new Error("PTY provider not loaded");
        shellReadyPromise = null;
        shellReadyResolve = null;
        shellReadyReject = null;
        rejectReady(error);
        return ready;
      }
      ptyProcess = ptyProvider.spawn(
        interpreter.command,
        interpreter.kind === "powershell"
          ? [...interpreter.args, "-Command", `Write-Output ${quotePowerShell(initMarker)}`]
        : interpreter.args,
        {
          cols,
          rows,
          cwd: deps.cwd ?? process.cwd(),
          env: { ...process.env, ...baseEnv } as Record<string, string>,
          windowsHide: true,
        },
      );

      // Wait for initial prompt by sending a unique echo command for shells
      // whose process starts without a command-line initialization script.
      let initBuffer = "";

      dataDisposable = ptyProcess.onData((data: string) => {
        // Route to pending command or init
        if (pendingCommand) {
          outputBuffer += data;
          parsePendingOutput();
        } else if (activeBackground) {
          const background = activeBackground;
          background.output += data;
          parseBackgroundOutput(background);
          background.lastOutputAt = Date.now();
        } else {
          initBuffer += data;
          // Strip control sequences for marker detection
          const cleaned = stripControlSequences(initBuffer);
          if (cleaned.includes(initMarker)) {
            shellReady = true;
            shellReadyResolve?.();
            shellReadyResolve = null;
            shellReadyReject = null;
          }
        }
      });

      exitDisposable = ptyProcess.onExit((event) => {
        if (!shellReady) {
          const error = new Error(`Shell exited before ready (code ${event.exitCode})`);
          const rejectReadyNow = shellReadyReject;
          shellReadyResolve = null;
          shellReadyReject = null;
          shellReadyPromise = null;
          ptyProcess = null;
          clearPtyHandlers();
          rejectReadyNow?.(error);
          if (disposeRequested) void finalizeStoppedResources();
          return;
        }
        // Shell exited unexpectedly
        ptyProcess = null;
        shellReady = false;
        shellReadyPromise = null;
        clearPtyHandlers();
        if (disposeRequested) {
          if (pendingCommand) clearTimeout(pendingCommand.timeout);
          if (activeBackground) {
            activeBackground.exited = true;
            activeBackground.exitCode = event.exitCode;
          }
          void finalizeStoppedResources();
          return;
        }
        if (pendingCommand) {
          clearTimeout(pendingCommand.timeout);
          void pendingCommand.writer?.close();
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
        if (activeBackground) {
          activeBackground.exited = true;
          activeBackground.exitCode = event.exitCode;
          closeBackgroundWriter(activeBackground);
          activeBackground = null;
        }
      });

      // Send init marker to detect shell readiness
      if (interpreter.kind !== "powershell") ptyProcess.write(`echo ${initMarker}\n`);
      return ready;
    } catch (error) {
      const proc = ptyProcess;
      ptyProcess = null;
      shellReadyPromise = null;
      shellReadyResolve = null;
      shellReadyReject = null;
      clearPtyHandlers();
      try { proc?.kill(); } catch { /* already exited */ }
      rejectReady(error);
      // Return the rejected shared promise so callers observe one failure and
      // the promise is never left as an unhandled orphan.
      return ready;
    }
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
        if (disposeRequested) return;
        completeCommand(exitCode);
        return;
      }
    }
  };

  const parseBackgroundOutput = (background: BackgroundShell): void => {
    const sentinelPattern = new RegExp(`${SENTINEL}${background.token}:(B|C:[^\\n]*|E:\\d+)`, "g");
    let match: RegExpExecArray | null;
    sentinelPattern.lastIndex = 0;
    while ((match = sentinelPattern.exec(background.output)) !== null) {
      const sentinelLine = match[1];
      if (sentinelLine === "B") {
        background.output = background.output.slice(match.index + match[0].length);
        sentinelPattern.lastIndex = 0;
      } else if (sentinelLine?.startsWith("C:")) {
        background.cwd = sentinelLine.slice(2).trim();
        background.output = background.output.slice(0, match.index) + background.output.slice(match.index + match[0].length);
        sentinelPattern.lastIndex = 0;
      } else if (sentinelLine?.startsWith("E:")) {
        background.exitCode = parseInt(sentinelLine.slice(2), 10);
        background.output = background.output.slice(0, match.index) + background.output.slice(match.index + match[0].length);
        background.exited = true;
        if (!disposeRequested) {
          closeBackgroundWriter(background);
          if (activeBackground === background) activeBackground = null;
        }
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
      handle = stored.ref.handle;
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
    if (pendingCommand || commandStarting) throw new Error("Another command is already running");
    if (activeBackground && !activeBackground.exited) throw new Error(`Background shell ${activeBackground.id} is still running`);

    commandStarting = true;
    let startFinished = false;
    let finishStart: () => void = () => undefined;
    const startPromise = new Promise<void>((resolve) => { finishStart = resolve; });
    commandStartPromise = startPromise;
    try {
      await ensureShell();
      if (!ptyProcess) {
        commandStarting = false;
        return { kind: "spawn-failed", reason: "no-shell", interpreter: interpreter.command, hint: "Shell not initialized" };
      }

      const token = randomBytes(8).toString("hex");
      const wrapped = buildCommandWrapper(command, token, interpreter.kind);
      const cwd = options.cwd ?? process.cwd();

      // Register writer for the duration of command execution
      const writer = deps.registerWriter ? await deps.registerWriter() : null;
      if (writer) startingWriters.add(writer);
      if (disposed) {
        commandStarting = false;
        if (writer) {
          if (stopped) {
            try {
              await writer.close();
              startingWriters.delete(writer);
            } catch {
              // Keep the writer tracked so disposal can retry the close.
            }
          }
        }
        finishStart();
        startFinished = true;
        return {
          kind: "spawn-failed",
          reason: "disposed",
          interpreter: interpreter.command,
          hint: "Shell supervisor has been disposed",
        };
      }

      return new Promise<ShellExecResult>((resolvePromise) => {
        outputBuffer = "";
        const timeout = setTimeout(() => {
          // Background this command
          const id = `sh_${++shellCounter}`;
          const bgShell: BackgroundShell = {
            id,
            token,
            command,
            output: outputBuffer,
            cwd: pendingCommand?.cwd ?? cwd,
            exited: false,
            exitCode: null,
            lastOutputAt: stripControlSequences(outputBuffer).length > 0 ? Date.now() : null,
            writer,
          };
          backgroundShells.set(id, bgShell);
          activeBackground = bgShell;
          pendingCommand = null;
          outputBuffer = "";

          const cleanedOutput = stripControlSequences(bgShell.output);
          resolvePromise({
            kind: "background",
            id,
            waitedMs: options.waitMs,
            cwd: bgShell.cwd,
            outputSoFar: cleanedOutput,
            command,
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
        if (writer) startingWriters.delete(writer);
        finishStart();
        startFinished = true;
        commandStarting = false;

        // If cwd is different from current, cd first
        const shell = ptyProcess;
        if (!shell) {
          clearTimeout(timeout);
          pendingCommand = null;
          commandStarting = false;
          void writer?.close();
          resolvePromise({ kind: "spawn-failed", reason: "no-shell", interpreter: interpreter.command, hint: "Shell not initialized" });
          return;
        }
        try {
          if (options.cwd) {
            shell.write(interpreter.kind === "powershell"
              ? `Set-Location -LiteralPath ${quotePowerShell(options.cwd)}; ${wrapped}\r\n`
              : `cd ${JSON.stringify(options.cwd)} && ${wrapped}\n`);
          } else {
            shell.write(`${wrapped}${interpreter.kind === "powershell" ? "\r\n" : "\n"}`);
          }
        } catch (error) {
          clearTimeout(timeout);
          pendingCommand = null;
          commandStarting = false;
          void writer?.close();
          resolvePromise({
            kind: "spawn-failed",
            reason: error instanceof Error ? error.message : String(error),
            interpreter: interpreter.command,
            hint: "Shell rejected the command",
          });
        }
      });
    } catch (error) {
      commandStarting = false;
      throw error;
    } finally {
      if (!startFinished) finishStart();
      if (commandStartPromise === startPromise) commandStartPromise = null;
    }
  };

  const read = async (id: string, offset: number = 0, length: number = 32768): Promise<OutputSlice & { running: boolean; exitCode?: number; lastOutputAt?: number; command?: string }> => {
    // Check background shells
    const bg = backgroundShells.get(id);
    if (bg) {
      const slice = sliceUtf8ByBytes(stripControlSequences(bg.output), offset, length);
      return {
        ...slice,
        running: !bg.exited,
        command: bg.command,
        ...(bg.exitCode !== null ? { exitCode: bg.exitCode } : {}),
        ...(bg.lastOutputAt !== null ? { lastOutputAt: bg.lastOutputAt } : {}),
      };
    }
    // Check output store (out_ handles)
    const result = outputStore.read(sessionId, id, offset, length);
    if (result.status === "ready") return { ...result.slice, running: false };
    if (result.status === "expired") throw new Error(`Output expired: ${id}`);
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
    if (bg.exited) return true;
    // Send Ctrl+C to the PTY. The command remains running until its sentinel
    // or the PTY exit event confirms that the interrupt took effect.
    if (!ptyProcess) return false;
    try {
      ptyProcess.write("\x03");
      return true;
    } catch {
      return false;
    }
  };

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    if (stopped) return Promise.resolve();

    disposeRequested = true;
    disposed = true;
    stopping = true;
    stoppingDirectory = deps.cwd ?? process.cwd();
    const commandStart = commandStartPromise;
    const work = (async (): Promise<void> => {
      const rejectReady = shellReadyReject;
      shellReadyResolve = null;
      shellReadyReject = null;
      shellReadyPromise = null;
      shellReady = false;
      rejectReady?.(new Error("Shell supervisor has been disposed"));
      if (pendingCommand) clearTimeout(pendingCommand.timeout);

      const proc = ptyProcess;
      let stopFailed = false;
      let stopError: unknown;
      if (proc) {
        // Register the waiter before kill: a synchronous fake or native PTY
        // exit must still count as confirmed termination.
        let waiterDispose: (() => void) | undefined;
        const exited = new Promise<void>((resolve, reject) => {
          let settled = false;
          let subscription: { dispose?(): void } | undefined;
          const timer = setTimeout(() => {
            settle(new Error("Shell process did not exit during disposal"));
          }, 3000);
          const settle = (error?: unknown): void => {
            if (settled) return;
            settled = true;
            if (error === undefined) resolve();
            else reject(error);
          };
          waiterDispose = () => {
            if (timer) clearTimeout(timer);
            try { subscription?.dispose?.(); } catch { /* already disposed */ }
          };
          try {
            subscription = proc.onExit(() => {
              if (timer) clearTimeout(timer);
              settle();
            });
          } catch (error) {
            if (timer) clearTimeout(timer);
            settle(error);
          }
        });
        try {
          proc.kill();
          await exited;
        } catch (error) {
          waiterDispose?.();
          // The waiter promise is intentionally abandoned on a kill failure;
          // consume its rejection after clearing its timer and listener.
          void exited.catch(() => undefined);
          stopFailed = true;
          stopError = error;
        }
        if (!stopFailed) {
          waiterDispose?.();
          // node-pty on Windows leaves anonymous pipe handles (Sockets) open
          // even after the process exits and handlers are disposed. unref() them
          // so the event loop can exit naturally.
          try { (proc as unknown as { destroy?: () => void }).destroy?.(); } catch { /* ignore */ }
          ptyProcess = null;
          shellReady = false;
          shellReadyPromise = null;
          clearPtyHandlers();
        }
      }

      // A command may still be awaiting writer registration. Let that setup
      // observe disposal and settle before finalizing the stopped resources;
      // otherwise a late writer could appear after dispose resolves.
      if (commandStart) await commandStart;
      if (stopFailed) throw stopError ?? new Error("Shell process did not stop during disposal");
      const finalized = await finalizeStoppedResources();
      if (!finalized) throw new Error("Shell writers did not close after process exit");

      // unref any lingering Socket handles from node-pty pipes
      if (process.platform === "win32") {
        try {
          const handles = (process as unknown as { _getActiveHandles?: () => Array<{ unref?: () => void; constructor?: { name?: string } }> })._getActiveHandles?.() ?? [];
          for (const h of handles) {
            if (h?.constructor?.name === "Socket" && typeof h.unref === "function") {
              h.unref();
            }
          }
        } catch { /* _getActiveHandles not available */ }
      }
    })();
    disposePromise = work.finally(() => {
      disposePromise = null;
    });
    return disposePromise;
  };

  const hasActiveCommandAt = (directory: string): boolean => {
    const target = path.resolve(directory);
    const same = (cwd: string): boolean => {
      const resolved = path.resolve(cwd);
      return process.platform === "win32"
        ? resolved.toLowerCase() === target.toLowerCase()
        : resolved === target;
    };
    if (stopping && stoppingDirectory && same(stoppingDirectory)) return true;
    if (pendingCommand && same(pendingCommand.cwd)) return true;
    for (const background of backgroundShells.values()) {
      if (!background.exited && same(background.cwd)) return true;
    }
    return false;
  };

  return { exec, read, write, kill, dispose, hasActiveCommandAt };
}
