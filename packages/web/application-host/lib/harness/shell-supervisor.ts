import { randomBytes } from "node:crypto";
import path from "node:path";
import { sliceUtf8ByBytes, type OutputSlice, type ShellExecResult } from "@piarium/protocol";
import type { CreateTerminalSessionInput, TerminalHandle, TerminalSessionApi } from "../terminal/session-api.js";
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
  onExit(handler: (event: { exitCode: number | null; signal: number }) => void): { dispose?(): void };
  pid?: number;
  resize(cols: number, rows: number): void;
  write(data: string): void;
}

export interface PtyProvider {
  backend: string;
  spawn(executable: string, args: string[], options: Record<string, unknown>): PtyProcess;
}

export function createTerminalSessionApiFromPtyProvider(ptyProvider: PtyProvider): TerminalSessionApi {
  const handles = new Map<string, TerminalHandle>();
  let nextId = 0;
  let nextHarnessId = 0;
  return {
    async createTerminalSession(input: CreateTerminalSessionInput): Promise<TerminalHandle> {
      const id = input.sessionId?.trim()
        || (input.owner === "harness" ? `sh_${++nextHarnessId}` : `term_${++nextId}`);
      const existing = handles.get(id);
      if (existing?.status === "running") return existing;
      const spawn = input.spawn ?? { executable: "bash", args: [] };
      const ptyProcess = ptyProvider.spawn(spawn.executable, spawn.args, {
        cols: input.cols ?? 120,
        rows: input.rows ?? 40,
        cwd: input.cwd,
        env: { ...globalThis.process.env, ...spawn.env },
      });
      const dataHandlers = new Set<(data: string) => void>();
      const exitHandlers = new Set<(event: { exitCode: number | null; signal: number }) => void>();
      let status: TerminalHandle["status"] = "running";
      let exitCode: number | null = null;
      let signal: number | null = null;
      ptyProcess.onData((data) => { for (const handler of dataHandlers) handler(data); });
      ptyProcess.onExit((event) => {
        status = "exited";
        exitCode = event.exitCode;
        signal = event.signal;
        for (const handler of exitHandlers) handler(event);
      });
      const handle: TerminalHandle = {
        get id() { return id; },
        get cwd() { return input.cwd; },
        get status() { return status; },
        write(data: string) { ptyProcess.write(data); },
        resize(cols: number, rows: number) { ptyProcess.resize(cols, rows); },
        onData(handler) {
          dataHandlers.add(handler);
          return { dispose: () => { dataHandlers.delete(handler); } };
        },
        onCommand() {
          return { dispose: () => undefined };
        },
        onExit(handler) {
          if (status === "exited") {
            let active = true;
            const event = { exitCode: exitCode ?? 0, signal: signal ?? 0 };
            queueMicrotask(() => { if (active) handler(event); });
            return { dispose: () => { active = false; } };
          }
          exitHandlers.add(handler);
          return { dispose: () => { exitHandlers.delete(handler); } };
        },
        waitForExit() {
          if (status === "exited") return Promise.resolve({ exitCode, signal });
          return new Promise((resolve) => {
            const disposable = handle.onExit((event) => {
              disposable.dispose();
              resolve({ exitCode: event.exitCode, signal: event.signal });
            });
          });
        },
        async terminate() {
          ptyProcess.kill();
        },
        async destroy() {
          try { ptyProcess.kill(); } catch { /* already gone */ }
          handles.delete(id);
        },
      };
      handles.set(id, handle);
      return handle;
    },
    attachTerminalSession(id: string) {
      return handles.get(id) ?? null;
    },
    inspectSession(id: string) {
      const handle = handles.get(id);
      if (!handle) return null;
      return {
        id: handle.id,
        cwd: handle.cwd,
        integration: "not-observed" as const,
        owner: "harness" as const,
        retainWhenDetached: true,
        status: handle.status,
      };
    },
    subscribeCommands() {
      return { dispose: () => undefined };
    },
  };
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
  createTerminalSession?: TerminalSessionApi["createTerminalSession"];
  commandLifecycle?: ShellCommandLifecycle;
  /** Deterministic test seam wrapping a fake PTY. Production uses terminal runtime. */
  ptyProvider?: PtyProvider;
}

export interface ShellCommandStartedEvent {
  command: string;
  commandRunId: string;
  executionId: string;
  cwd: string;
  startedAt: number;
  toolCallId?: string;
}

export interface ShellCommandCompletedEvent extends ShellCommandStartedEvent {
  endedAt: number;
  exitCode: number | null;
  cancelled: boolean;
  outputHandle?: string;
  outputPreview?: string;
}

export interface ShellCommandLifecycle {
  started?(event: ShellCommandStartedEvent): void | Promise<void>;
  completed?(event: ShellCommandCompletedEvent): void | Promise<void>;
}

interface BackgroundShell {
  id: string;
  token: string;
  executionId: string;
  commandRunId: string;
  startedAt: number;
  command: string;
  output: string;
  cwd: string;
  exited: boolean;
  exitCode: number | null;
  cancelRequested: boolean;
  lifecycleCompleted: boolean;
  lifecyclePromise?: Promise<void>;
  lastOutputAt: number | null;
  writer: { close: () => Promise<void> } | null;
  writerClosePromise?: Promise<void>;
  handle: TerminalHandle;
  toolCallId?: string;
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
  const shellChangeWaiters = new Map<string, Set<() => void>>();
  const acceptedExecutions = new Map<string, {
    command: string;
    cwd: string | undefined;
    promise: Promise<ShellExecResult>;
    result?: ShellExecResult;
  }>();
  let activeBackground: BackgroundShell | null = null;
  let disposed = false;
  let sessionHandle: TerminalHandle | null = null;
  const liveHandles = new Set<TerminalHandle>();
  const unavailableHandles = new Map<TerminalHandle, Error>();
  const handleBindings = new Map<TerminalHandle, Set<{ dispose?(): void }>>();
  const terminalApi: TerminalSessionApi | null = deps.createTerminalSession
    ? {
      createTerminalSession: deps.createTerminalSession,
      attachTerminalSession: (id) => {
        if (sessionHandle?.id === id) return sessionHandle;
        for (const background of backgroundShells.values()) {
          if (background.handle.id === id) return background.handle;
        }
        return null;
      },
      inspectSession: () => null,
      subscribeCommands: () => ({ dispose: () => undefined }),
    }
    : deps.ptyProvider
      ? createTerminalSessionApiFromPtyProvider(deps.ptyProvider)
      : null;
  let lastCwd = deps.cwd ?? process.cwd();
  let outputBuffer = "";
  let shellReady = false;
  let shellReadyPromise: Promise<void> | null = null;
  let shellReadyResolve: (() => void) | null = null;
  let shellReadyReject: ((error: unknown) => void) | null = null;
  // Pending command state
  type ShellWriter = { close: () => Promise<void> };
  interface PendingCommand {
    token: string;
    executionId: string;
    commandRunId: string;
    command: string;
    resolve: (result: ShellExecResult) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
    cwd: string;
    writer: ShellWriter | null;
    startedAt: number;
    toolCallId?: string;
    abortCleanup?: () => void;
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
  const lingeringWriters = new Map<ShellWriter, string>();
  const commandLifecyclePromises = new Set<Promise<void>>();

  const trackCommandLifecycle = (work: Promise<void>): Promise<void> => {
    commandLifecyclePromises.add(work);
    void work.then(
      () => commandLifecyclePromises.delete(work),
      () => commandLifecyclePromises.delete(work),
    );
    return work;
  };

  const notifyShellChanged = (id: string): void => {
    const waiters = shellChangeWaiters.get(id);
    if (!waiters) return;
    shellChangeWaiters.delete(id);
    for (const wake of waiters) wake();
  };

  const closeCommandWriter = async (writer: ShellWriter | null, cwd: string): Promise<void> => {
    if (!writer) return;
    try {
      await writer.close();
      lingeringWriters.delete(writer);
    } catch (error) {
      lingeringWriters.set(writer, cwd);
      throw error;
    }
  };

  const notifyCommandStarted = async (event: ShellCommandStartedEvent): Promise<void> => {
    try { await deps.commandLifecycle?.started?.(event); } catch { /* observers cannot change shell behavior */ }
  };

  const notifyCommandCompleted = (event: ShellCommandCompletedEvent): Promise<void> => trackCommandLifecycle(
    Promise.resolve().then(async () => {
      try { await deps.commandLifecycle?.completed?.(event); } catch { /* observers cannot change shell behavior */ }
    }),
  );

  const closeBackgroundWriter = (background: BackgroundShell): Promise<void> => {
    if (background.writerClosePromise) return background.writerClosePromise;
    const writer = background.writer;
    if (!writer) return Promise.resolve();
    const closing = writer.close().then(() => {
      if (background.writer === writer) background.writer = null;
    });
    background.writerClosePromise = closing;
    void closing.then(
      () => { if (background.writerClosePromise === closing) delete background.writerClosePromise; },
      () => { if (background.writerClosePromise === closing) delete background.writerClosePromise; },
    );
    return closing;
  };

  const completeBackgroundCommand = (background: BackgroundShell, exitCode: number | null): Promise<void> => {
    if (background.lifecycleCompleted) return background.lifecyclePromise ?? closeBackgroundWriter(background);
    background.lifecycleCompleted = true;
    background.exited = true;
    background.exitCode = exitCode;
    const completed = notifyCommandCompleted({
      command: background.command,
      commandRunId: background.commandRunId,
      executionId: background.executionId,
      cwd: background.cwd,
      startedAt: background.startedAt,
      endedAt: Date.now(),
      exitCode,
      cancelled: background.cancelRequested,
      outputPreview: stripControlSequences(background.output),
      ...(background.toolCallId === undefined ? {} : { toolCallId: background.toolCallId }),
    });
    const lifecycle = trackCommandLifecycle(completed.then(() => closeBackgroundWriter(background)));
    background.lifecyclePromise = lifecycle;
    void lifecycle.then(
      () => { if (background.lifecyclePromise === lifecycle) delete background.lifecyclePromise; },
      () => { if (background.lifecyclePromise === lifecycle) delete background.lifecyclePromise; },
    );
    return lifecycle;
  };

  const unbindHandle = (handle: TerminalHandle): void => {
    const disposables = handleBindings.get(handle);
    if (disposables) {
      for (const disposable of disposables) {
        try { disposable.dispose?.(); } catch { /* already disposed */ }
      }
      handleBindings.delete(handle);
    }
    liveHandles.delete(handle);
  };

  const clearAllBindings = (): void => {
    for (const handle of [...handleBindings.keys()]) unbindHandle(handle);
  };

  const trackDisposable = (handle: TerminalHandle, disposable: { dispose?(): void }): void => {
    let disposables = handleBindings.get(handle);
    if (!disposables) {
      disposables = new Set();
      handleBindings.set(handle, disposables);
    }
    disposables.add(disposable);
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
        await Promise.all([...commandLifecyclePromises]);
        const lingering = [...lingeringWriters.entries()];
        if (pending) await closePendingWriterAfterStop(pending);
        await Promise.all(backgrounds.map((background) => closeBackgroundWriterAfterStop(background)));
        await Promise.all(starting.map(async (writer) => {
          await writer.close();
          if (startingWriters.has(writer)) startingWriters.delete(writer);
        }));
        await Promise.all(lingering.map(([writer, cwd]) => closeCommandWriter(writer, cwd)));
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

  const resolveTerminalApi = (): TerminalSessionApi => {
    if (terminalApi) return terminalApi;
    throw new Error("Terminal runtime is not available");
  };

  const bindSessionHandle = (handle: TerminalHandle, initMarker: string): void => {
    let initBuffer = "";
    liveHandles.add(handle);
    const isCurrentSession = (): boolean => sessionHandle === handle;
    trackDisposable(handle, handle.onData((data: string) => {
      if (pendingCommand && isCurrentSession()) {
        outputBuffer += data;
        parsePendingOutput();
        return;
      }
      const background = backgroundShells.get(handle.id);
      if (background && !background.exited) {
        background.output += data;
        parseBackgroundOutput(background);
        background.lastOutputAt = Date.now();
        notifyShellChanged(background.id);
        return;
      }
      if (isCurrentSession() && !shellReady) {
        initBuffer += data;
        const cleaned = stripControlSequences(initBuffer);
        if (cleaned.includes(initMarker)) {
          shellReady = true;
          shellReadyResolve?.();
          shellReadyResolve = null;
          shellReadyReject = null;
        }
      }
    }));

    if (handle.onError) trackDisposable(handle, handle.onError((error) => {
      unavailableHandles.set(handle, error);
      if (isCurrentSession()) {
        shellReady = false;
        shellReadyReject?.(error);
        if (pendingCommand) { clearTimeout(pendingCommand.timeout); pendingCommand.reject(error); }
      }
      // Keep handles and writers until a real exit, not merely a broken pipe.
    }));

    trackDisposable(handle, handle.onExit((event) => {
      unavailableHandles.delete(handle);
      const wasCurrent = isCurrentSession();
      const wasInitializing = wasCurrent && !shellReady;
      liveHandles.delete(handle);
      if (wasCurrent) {
        sessionHandle = null;
        shellReady = false;
        shellReadyPromise = null;
      }
      if (wasInitializing) {
        const rejectReadyNow = shellReadyReject;
        shellReadyResolve = null;
        shellReadyReject = null;
        shellReadyPromise = null;
        rejectReadyNow?.(new Error(`Shell exited before ready (code ${event.exitCode})`));
        if (disposeRequested && liveHandles.size === 0) void finalizeStoppedResources();
        return;
      }
      if (disposeRequested) {
        const ownsPending = pendingCommand?.commandRunId === handle.id;
        if (ownsPending) {
          clearTimeout(pendingCommand!.timeout);
          completeCommand(event.exitCode, true, true);
        }
        const background = backgroundShells.get(handle.id);
        if (background) {
          void completeBackgroundCommand(background, event.exitCode).catch(() => undefined);
          notifyShellChanged(background.id);
        }
        if (liveHandles.size === 0) void finalizeStoppedResources();
        return;
      }
      if (pendingCommand && wasCurrent) {
        clearTimeout(pendingCommand.timeout);
        completeCommand(event.exitCode, false);
      }
      const background = backgroundShells.get(handle.id);
      if (background) {
        void completeBackgroundCommand(background, event.exitCode).catch(() => undefined);
        notifyShellChanged(background.id);
        if (activeBackground === background) activeBackground = null;
      }
    }));
  };

  const ensureShell = async (): Promise<void> => {
    if (disposed) throw new Error("Shell supervisor has been disposed");
    if (sessionHandle && unavailableHandles.has(sessionHandle)) throw unavailableHandles.get(sessionHandle)!;
    if (shellReady && sessionHandle?.status === "running") return;
    if (sessionHandle?.status === "running") return shellReadyPromise ?? Promise.resolve();

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
    shellReady = false;

    try {
      const api = resolveTerminalApi();
      if (disposed) throw new Error("Shell supervisor has been disposed");
      const spawnArgs = interpreter.kind === "powershell"
        ? [...interpreter.args, "-Command", `Write-Output ${quotePowerShell(initMarker)}`]
        : interpreter.args;
      sessionHandle = await api.createTerminalSession({
        cwd: lastCwd,
        cols,
        rows,
        owner: "harness",
        retainWhenDetached: true,
        registerProcessWriter: false,
        spawn: {
          executable: interpreter.command,
          args: spawnArgs,
          env: { ...process.env, ...baseEnv } as Record<string, string>,
        },
      });
      bindSessionHandle(sessionHandle, initMarker);
      if (interpreter.kind !== "powershell") sessionHandle.write(`echo ${initMarker}\n`);
      return ready;
    } catch (error) {
      const handle = sessionHandle;
      sessionHandle = null;
      shellReadyPromise = null;
      shellReadyResolve = null;
      shellReadyReject = null;
      if (handle) unbindHandle(handle);
      try { await handle?.destroy(); } catch { /* already exited */ }
      rejectReady(error);
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
        lastCwd = pendingCommand.cwd;
        outputBuffer = outputBuffer.slice(0, match.index) + outputBuffer.slice(match.index + match[0].length);
        sentinelPattern.lastIndex = 0;
      } else if (sentinelLine?.startsWith("E:")) {
        const exitCode = parseInt(sentinelLine.slice(2), 10);
        // Remove the sentinel from output
        outputBuffer = outputBuffer.slice(0, match.index) + outputBuffer.slice(match.index + match[0].length);
        completeCommand(exitCode, disposeRequested);
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
        lastCwd = background.cwd;
        background.output = background.output.slice(0, match.index) + background.output.slice(match.index + match[0].length);
        sentinelPattern.lastIndex = 0;
      } else if (sentinelLine?.startsWith("E:")) {
        background.exitCode = parseInt(sentinelLine.slice(2), 10);
        background.output = background.output.slice(0, match.index) + background.output.slice(match.index + match[0].length);
        void completeBackgroundCommand(background, background.exitCode).catch(() => undefined);
        if (activeBackground === background) activeBackground = null;
        return;
      }
    }
  };

  const completeCommand = (exitCode: number | null, cancelled: boolean, disposedResult = false): void => {
    if (!pendingCommand) return;
    clearTimeout(pendingCommand.timeout);
    pendingCommand.abortCleanup?.();
    const cmd = pendingCommand;
    pendingCommand = null;

    const cleanedOutput = stripControlSequences(outputBuffer);
    outputBuffer = "";
    lastCwd = cmd.cwd;

    let handle: string | null = null;
    let shown: { head: number; tail: number; total: number } | null = null;
    const totalBytes = Buffer.byteLength(cleanedOutput, "utf8");
    if (totalBytes > 32768) {
      const stored = outputStore.store(sessionId, cleanedOutput, "bash");
      handle = stored.ref.handle;
      shown = { head: 0, tail: 0, total: stored.total };
    }

    const result: ShellExecResult = disposedResult
      ? {
        kind: "spawn-failed",
        reason: "disposed",
        interpreter: interpreter.command,
        hint: "Shell supervisor has been disposed",
      }
      : {
        kind: "completed",
        exitCode,
        durationMs: Date.now() - cmd.startedAt,
        cwd: cmd.cwd,
        stdout: cleanedOutput,
        stderr: "",
        handle,
        shown,
        ...(cmd.toolCallId === undefined ? {} : { toolCallId: cmd.toolCallId }),
        executionId: cmd.executionId,
      };
    const completion = notifyCommandCompleted({
      command: cmd.command,
      commandRunId: cmd.commandRunId,
      executionId: cmd.executionId,
      cwd: cmd.cwd,
      startedAt: cmd.startedAt,
      endedAt: Date.now(),
      exitCode,
      cancelled,
      ...(handle ? { outputHandle: handle } : {}),
      outputPreview: cleanedOutput,
      ...(cmd.toolCallId === undefined ? {} : { toolCallId: cmd.toolCallId }),
    }).then(async () => {
      try { await closeCommandWriter(cmd.writer, cmd.cwd); } catch { /* retained for disposal retry */ }
      cmd.resolve(result);
    });
    trackCommandLifecycle(completion);
  };

  const cancelUnwrittenCommand = ({
    command,
    commandRunId,
    executionId,
    cwd,
    startedAt,
    writer,
    outputPreview = "",
    toolCallId,
  }: {
    command: string;
    commandRunId: string;
    executionId: string;
    cwd: string;
    startedAt: number;
    writer: ShellWriter | null;
    outputPreview?: string;
    toolCallId?: string;
  }): void => {
    const completion = notifyCommandCompleted({
      command,
      commandRunId,
      executionId,
      cwd,
      startedAt,
      endedAt: Date.now(),
      exitCode: -1,
      cancelled: true,
      outputPreview,
      ...(toolCallId === undefined ? {} : { toolCallId }),
    }).then(async () => {
      try { await closeCommandWriter(writer, cwd); } catch { /* retained for disposal retry */ }
    });
    trackCommandLifecycle(completion);
  };

  const execCommand = async (command: string, options: { cwd?: string; waitMs: number; toolCallId?: string; signal?: AbortSignal }): Promise<ShellExecResult> => {
    if (disposed) return { kind: "spawn-failed", reason: "disposed", interpreter: interpreter.command, hint: "Shell supervisor has been disposed" };
    if (pendingCommand || commandStarting) throw new Error("Another command is already running");

    commandStarting = true;
    let startFinished = false;
    let finishStart: () => void = () => undefined;
    const startPromise = new Promise<void>((resolve) => { finishStart = resolve; });
    commandStartPromise = startPromise;
    try {
      // Do not let a new wrapper cross the previous command's completion
      // callback and writer-release boundary.
      await Promise.all([...commandLifecyclePromises]);
      await ensureShell();
      if (!sessionHandle) {
        commandStarting = false;
        return { kind: "spawn-failed", reason: "no-shell", interpreter: interpreter.command, hint: "Shell not initialized" };
      }

      const token = randomBytes(8).toString("hex");
      const wrapped = buildCommandWrapper(command, token, interpreter.kind);
      const cwd = options.cwd ?? lastCwd;
      const startedAt = Date.now();
      const commandRunId = sessionHandle.id;

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

      await notifyCommandStarted({
        command,
        commandRunId,
        executionId: token,
        cwd,
        startedAt,
        ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
      });
      if (disposed) {
        commandStarting = false;
        if (writer && stopped) {
          try { await writer.close(); startingWriters.delete(writer); } catch { /* disposal retries the close */ }
        }
        cancelUnwrittenCommand({ command, commandRunId, executionId: token, cwd, startedAt, writer: writer && !stopped ? writer : null,
          ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }) });
        finishStart();
        startFinished = true;
        return {
          kind: "spawn-failed",
          reason: "disposed",
          interpreter: interpreter.command,
          hint: "Shell supervisor has been disposed",
        };
      }

      return new Promise<ShellExecResult>((resolvePromise, rejectPromise) => {
        outputBuffer = "";
        const detachToBackground = (): void => {
          if (pendingCommand?.token !== token) return;
          clearTimeout(timeout);
          pendingCommand.abortCleanup?.();
          const handle = sessionHandle;
          if (!handle) {
            pendingCommand = null;
            resolvePromise({
              kind: "spawn-failed",
              reason: "no-shell",
              interpreter: interpreter.command,
              hint: "Shell not initialized",
            });
            return;
          }
          const id = handle.id;
          const bgShell: BackgroundShell = {
            id,
            token,
            executionId: token,
            commandRunId: id,
            startedAt,
            command,
            output: outputBuffer,
            cwd: pendingCommand?.cwd ?? cwd,
            exited: false,
            exitCode: null,
            cancelRequested: false,
            lifecycleCompleted: false,
            lastOutputAt: stripControlSequences(outputBuffer).length > 0 ? Date.now() : null,
            writer,
            handle,
            ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
          };
          backgroundShells.set(id, bgShell);
          activeBackground = bgShell;
          lastCwd = bgShell.cwd;
          sessionHandle = null;
          shellReady = false;
          shellReadyPromise = null;
          pendingCommand = null;
          outputBuffer = "";

          const cleanedOutput = stripControlSequences(bgShell.output);
          resolvePromise({
            kind: "background",
            id,
            waitedMs: Math.max(0, Date.now() - startedAt),
            cwd: bgShell.cwd,
            outputSoFar: cleanedOutput,
            command,
            ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
            executionId: token,
          });
        };
        const timeout = setTimeout(detachToBackground, options.waitMs);
        const onAbort = (): void => detachToBackground();

        pendingCommand = {
          token,
          executionId: token,
          commandRunId,
          command,
          resolve: resolvePromise,
          reject: rejectPromise,
          timeout,
          cwd,
          writer,
          startedAt,
          ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
          ...(options.signal === undefined ? {} : {
            abortCleanup: () => options.signal?.removeEventListener("abort", onAbort),
          }),
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) queueMicrotask(detachToBackground);
        if (writer) startingWriters.delete(writer);
        finishStart();
        startFinished = true;
        commandStarting = false;

        // If cwd is different from current, cd first
        const shell = sessionHandle;
        if (!shell) {
          clearTimeout(timeout);
          pendingCommand?.abortCleanup?.();
          pendingCommand = null;
          commandStarting = false;
          cancelUnwrittenCommand({ command, commandRunId, executionId: token, cwd, startedAt, writer,
            ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }) });
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
          pendingCommand?.abortCleanup?.();
          pendingCommand = null;
          commandStarting = false;
          cancelUnwrittenCommand({
            command,
            commandRunId,
            executionId: token,
            cwd,
            startedAt,
            writer,
            outputPreview: stripControlSequences(outputBuffer),
            ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
          });
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

  const exec = async (
    command: string,
    options: { cwd?: string; waitMs: number; toolCallId?: string; signal?: AbortSignal },
  ): Promise<ShellExecResult> => {
    const toolCallId = options.toolCallId;
    if (toolCallId) {
      const accepted = acceptedExecutions.get(toolCallId);
      if (accepted) {
        if (accepted.command !== command || accepted.cwd !== options.cwd) {
          throw new Error(`Tool call ${toolCallId} is already bound to another command or working directory`);
        }
        return accepted.promise;
      }
    }
    const promise = execCommand(command, options);
    if (toolCallId) {
      const accepted: { command: string; cwd: string | undefined; promise: Promise<ShellExecResult>; result?: ShellExecResult } = {
        command, cwd: options.cwd, promise,
      };
      acceptedExecutions.set(toolCallId, accepted);
      void promise.then((result) => { accepted.result = result; }, () => undefined);
    }
    return promise;
  };

  const read = async (id: string, offset: number = 0, length: number = 32768): Promise<OutputSlice & { running: boolean; exitCode?: number; executionId?: string; lastOutputAt?: number; command?: string; shellId?: string }> => {
    const recovered = acceptedExecutions.get(id)?.result;
    if (recovered?.kind === "background" && recovered.id !== id) {
      const result = await read(recovered.id, offset, length);
      return { ...result, shellId: recovered.id };
    }
    if (recovered?.kind === "completed") {
      const text = `${recovered.stdout}${recovered.stderr ? `\n[stderr]\n${recovered.stderr}` : ""}`;
      return { ...sliceUtf8ByBytes(text, offset, length), running: false,
        ...(recovered.executionId === undefined ? {} : { executionId: recovered.executionId }),
        ...(recovered.exitCode === null ? {} : { exitCode: recovered.exitCode }) };
    }
    // Check background shells
    const bg = backgroundShells.get(id);
    if (bg) {
      if (unavailableHandles.has(bg.handle)) throw unavailableHandles.get(bg.handle)!;
      const slice = sliceUtf8ByBytes(stripControlSequences(bg.output), offset, length);
      return {
        ...slice,
        running: !bg.exited,
        command: bg.command,
        executionId: bg.executionId,
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

  const waitForOutput = async (
    id: string,
    offset: number,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<void> => {
    const recovered = acceptedExecutions.get(id)?.result;
    const shellId = recovered?.kind === "background" ? recovered.id : id;
    const hasChange = (): boolean => {
      const background = backgroundShells.get(shellId);
      if (!background) return true;
      if (unavailableHandles.has(background.handle) || background.exited) return true;
      return Buffer.byteLength(stripControlSequences(background.output), "utf8") > offset;
    };
    if (waitMs <= 0 || hasChange()) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const waiters = shellChangeWaiters.get(shellId) ?? new Set<() => void>();
      shellChangeWaiters.set(shellId, waiters);
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        waiters.delete(wake);
        if (waiters.size === 0 && shellChangeWaiters.get(shellId) === waiters) shellChangeWaiters.delete(shellId);
      };
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const wake = (): void => finish();
      const onAbort = (): void => finish(new Error("Shell output wait aborted"));
      waiters.add(wake);
      const timer = setTimeout(wake, waitMs);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      // Close the event-subscription race: output may have arrived between the
      // first check and registering this waiter.
      if (hasChange()) wake();
    });
  };

  const write = async (id: string, text: string): Promise<boolean> => {
    const recovered = acceptedExecutions.get(id)?.result;
    const bg = backgroundShells.get(recovered?.kind === "background" ? recovered.id : id);
    if (!bg || bg.exited) return false;
    try {
      bg.handle.write(text);
      return true;
    } catch {
      return false;
    }
  };

  const kill = async (id: string): Promise<boolean> => {
    const recovered = acceptedExecutions.get(id)?.result;
    const bg = backgroundShells.get(recovered?.kind === "background" ? recovered.id : id);
    if (!bg) return false;
    if (bg.exited) {
      try { await completeBackgroundCommand(bg, bg.exitCode); } catch { return false; }
      return true;
    }
    if (bg.handle.status === "exited") {
      try { await completeBackgroundCommand(bg, bg.exitCode); } catch { return false; }
      return bg.exited;
    }
    bg.cancelRequested = true;
    // A background handle is no longer the foreground session. Terminate that
    // exact PTY through the runtime, which owns process-tree escalation and
    // the real exit event. A successful write or interrupt alone is not a kill.
    try {
      await bg.handle.terminate(true);
    } catch {
      return false;
    }
    if (!bg.exited && (bg.handle.status as TerminalHandle["status"]) !== "exited") return false;
    try { await completeBackgroundCommand(bg, bg.exitCode); } catch { return false; }
    return bg.exited;
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
      for (const id of [...shellChangeWaiters.keys()]) notifyShellChanged(id);
      const rejectReady = shellReadyReject;
      shellReadyResolve = null;
      shellReadyReject = null;
      shellReadyPromise = null;
      shellReady = false;
      rejectReady?.(new Error("Shell supervisor has been disposed"));
      if (pendingCommand) {
        clearTimeout(pendingCommand.timeout);
        pendingCommand.abortCleanup?.();
      }

      const handles = [
        ...(sessionHandle ? [sessionHandle] : []),
        ...[...backgroundShells.values()].map((background) => background.handle),
      ];
      sessionHandle = null;
      shellReady = false;
      shellReadyPromise = null;
      let stopFailed = false;
      let stopError: unknown;
      for (const handle of handles) {
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
            subscription = handle.onExit(() => {
              if (timer) clearTimeout(timer);
              settle();
            });
          } catch (error) {
            if (timer) clearTimeout(timer);
            settle(error);
          }
        });
        try {
          await handle.terminate();
          await exited;
          await handle.destroy();
        } catch (error) {
          waiterDispose?.();
          void exited.catch(() => undefined);
          stopFailed = true;
          stopError = error;
          break;
        }
        waiterDispose?.();
      }
      if (!stopFailed) clearAllBindings();

      // A command may still be awaiting writer registration. Let that setup
      // observe disposal and settle before finalizing the stopped resources;
      // otherwise a late writer could appear after dispose resolves.
      if (commandStart) await commandStart;
      if (stopFailed) throw stopError ?? new Error("Shell process did not stop during disposal");
      const finalized = await finalizeStoppedResources();
      if (!finalized) throw new Error("Shell writers did not close after process exit");


    })();
    disposePromise = work.finally(() => {
      disposePromise = null;
    });
    return disposePromise;
  };

  const hasActiveCommandAt = (directory: string): boolean => {
    const target = path.resolve(directory);
    const overlaps = (cwd: string): boolean => {
      const resolved = path.resolve(cwd);
      const left = process.platform === "win32" ? resolved.toLowerCase() : resolved;
      const right = process.platform === "win32" ? target.toLowerCase() : target;
      const relative = path.relative(left, right);
      const reverse = path.relative(right, left);
      const contained = (value: string): boolean => value === ""
        || (value !== ".." && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value));
      return contained(relative) || contained(reverse);
    };
    const admittedRoot = deps.cwd ?? process.cwd();
    if (stopping && stoppingDirectory && overlaps(stoppingDirectory)) return true;
    if (pendingCommand && (overlaps(pendingCommand.cwd) || overlaps(admittedRoot))) return true;
    for (const background of backgroundShells.values()) {
      if ((!background.exited || background.writer !== null || background.writerClosePromise !== undefined)
        && (overlaps(background.cwd) || overlaps(admittedRoot))) return true;
    }
    for (const cwd of lingeringWriters.values()) if (overlaps(cwd) || overlaps(admittedRoot)) return true;
    return false;
  };

  return { exec, read, waitForOutput, write, kill, dispose, hasActiveCommandAt };
}
