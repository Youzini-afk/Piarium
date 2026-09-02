import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { Express, Request, Response } from 'express';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type fsModule from 'node:fs';
import type pathModule from 'node:path';
import {
  TERMINAL_WS_MAX_PAYLOAD_BYTES,
  TERMINAL_WS_PATH,
  createTerminalWsControlFrame,
  parseRequestPathname,
  readTerminalWsControlFrame,
} from './terminal-ws-protocol.js';
import { sanitizeTerminalHistoryChunk } from './history.js';
import { consumeTerminalThemeQueries, terminalThemeModeReport } from './theme-response.js';
import { createTerminalShellResolver, getTerminalShellLoginArgs, normalizeTerminalShell } from './shells.js';
import { createWorkspaceConfig, ensureWorkspaceRoot } from '../workspace/workspace-config.js';
import { assertAbsolutePathInWorkspace, resolveWorkspacePath } from '../workspace/path-safety.js';
import { resolveLinuxPtyLaunch, stripAppImageArgv0Leak } from '../platform/inherited-env.js';
import type { DocumentAuthority } from '../documents/authority.js';
import type { TerminalShellPreference } from './shells.js';

const MAX_SESSIONS = 20;
const MAX_HISTORY_BYTES = 512 * 1024;
const MAX_INPUT_CHARS = 65_536;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const TERMINATION_GRACE_MS = 1000;
const validateSize = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;

type ProcessWriter = Awaited<ReturnType<DocumentAuthority['registerWriterForScope']>>;

interface WriterState {
  released: boolean;
  writer: ProcessWriter;
}

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

type TerminalEvent =
  | { data: string; process: PtyProcess; type: 'output'; writerState: WriterState }
  | { exitCode: number; process: PtyProcess; signal: number; type: 'exit'; writerState: WriterState };

interface TerminalSession {
  backend?: string;
  cols: number;
  cwd: string;
  draining: boolean;
  eventQueue: TerminalEvent[];
  exitCode: number | null;
  history: string;
  id: string;
  lastActivity: number;
  loginShell: boolean;
  pendingHistoryControlSequence: string;
  pendingThemeControlSequence: string;
  process: PtyProcess | null;
  rows: number;
  sequence: number;
  shell: TerminalShellPreference;
  signal: number | null;
  status: 'exited' | 'running';
  terminalBackground: string;
  terminalForeground: string;
  themeMode: 'dark' | 'light';
  themeModeEnabled: boolean;
  writerGeneration: number;
  writerState: WriterState | null;
}

interface TerminalAttachment {
  initializing: boolean;
  pending: Array<Record<string, unknown>>;
}

interface TerminalConnection {
  attachments: Map<string, TerminalAttachment>;
  socket: WebSocket;
}

interface TerminalRuntimeDependencies {
  app: Express;
  buildAugmentedPath: () => string;
  documents?: Pick<DocumentAuthority, 'registerWriterForScope'>;
  fs: typeof fsModule;
  isExecutable(path: string): boolean;
  isRequestOriginAllowed(req: IncomingMessage): Promise<boolean>;
  loadPtyProvider?: () => Promise<PtyProvider>;
  path: typeof pathModule;
  rejectWebSocketUpgrade(socket: Duplex, statusCode: number, message: string): void;
  searchPathFor(name: string, searchPath: string): string | null;
  server: Server;
  TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: number;
  terminalTerminationGraceMs?: number;
  uiAuthController?: {
    enabled: boolean;
    ensureSessionToken(req: IncomingMessage, res: null): Promise<string | null>;
  } | null;
}

interface StartSessionInput {
  cols: number;
  cwd: string;
  loginShell: boolean;
  rows: number;
  shell: TerminalShellPreference;
  terminalBackground?: unknown;
  terminalForeground?: unknown;
  themeMode?: unknown;
}

const errorRecord = (error: unknown): Record<string, unknown> => (
  error && typeof error === 'object' ? error as Record<string, unknown> : {}
);

const errorMessage = (error: unknown, fallback: string): string => error instanceof Error && error.message ? error.message : fallback;

const releaseProcessWriter = async (writer: ProcessWriter, mutated = true): Promise<void> => {
  if (!writer) return;
  if (mutated) {
    try { await writer.markMutated(); } catch { /* authority may already be gone */ }
  }
  try { await writer.close(); } catch { /* authority may already be gone */ }
};

const trimHistory = (history: string): string => {
  const bytes = Buffer.from(history);
  if (bytes.byteLength <= MAX_HISTORY_BYTES) return history;
  let start = bytes.byteLength - MAX_HISTORY_BYTES;
  while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
};

export function createTerminalRuntime({
  app, server, fs, path, uiAuthController, buildAugmentedPath, searchPathFor, isExecutable,
  isRequestOriginAllowed, rejectWebSocketUpgrade, TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS,
  loadPtyProvider, terminalTerminationGraceMs = TERMINATION_GRACE_MS,
  documents,
}: TerminalRuntimeDependencies) {
  const sessions = new Map<string, TerminalSession>();
  const pendingSessionCreates = new Map<string, { cwd: string; loginShell: boolean; promise: Promise<TerminalSession>; shell: TerminalShellPreference }>();
  const pendingSessionRestarts = new Map<string, Promise<void>>();
  const connections = new Set<TerminalConnection>();
  const pendingTerminations = new Set<Promise<void>>();
  const runtime = 'Bun' in globalThis ? 'bun' : 'node';
  let ptyProviderPromise: Promise<PtyProvider> | null = null;
  let wsServer: WebSocketServer | null = new WebSocketServer({ noServer: true, maxPayload: TERMINAL_WS_MAX_PAYLOAD_BYTES });
  const shellResolver = createTerminalShellResolver({ fs, path, searchPathFor, isExecutable, buildAugmentedPath });

  const acquireWriter = async (
    scopeId: unknown,
    owner: Parameters<DocumentAuthority['registerWriterForScope']>[1],
  ): Promise<ProcessWriter> => {
    const options = { mode: 'process', purpose: 'terminal-process' };
    if (typeof documents?.registerWriterForScope === 'function') {
      return documents.registerWriterForScope(scopeId, owner, options);
    }
    return null;
  };

  const releaseWriterState = async (state: WriterState | null, mutated = true): Promise<void> => {
    if (!state || state.released) return;
    state.released = true;
    const writer = state.writer;
    state.writer = null;
    await releaseProcessWriter(writer, mutated);
  };

  const getPtyProvider = async (): Promise<PtyProvider> => {
    if (!ptyProviderPromise) {
      ptyProviderPromise = loadPtyProvider ? loadPtyProvider() : (async () => {
        if ('Bun' in globalThis) {
          try { const pty = await import('bun-pty'); return { spawn: pty.spawn as PtyProvider['spawn'], backend: 'bun-pty' }; } catch { /* fall through */ }
        }
        const pty = await import('node-pty');
        return { spawn: pty.spawn as PtyProvider['spawn'], backend: 'node-pty' };
      })();
    }
    return ptyProviderPromise;
  };

  const spawnPty = async ({ cwd, cols, rows, themeMode, shell, loginShell }: StartSessionInput) => {
    const provider = await getPtyProvider();
    const resolvedShell = await shellResolver.resolve(shell);
    let lastError: unknown = null;
    for (const executable of resolvedShell.executables) {
      const args = loginShell ? getTerminalShellLoginArgs(executable) : [];
      if (!args) throw new Error(`Terminal shell "${resolvedShell.id}" does not support login mode`);
      try {
        const env: NodeJS.ProcessEnv = { ...process.env, PATH: buildAugmentedPath(), TERM: 'xterm-256color', COLORTERM: 'truecolor', COLORFGBG: themeMode === 'light' ? '0;15' : '15;0' };
        // The daemon's IPC fd is closed inside the PTY. An explicit override is
        // required because bun-pty also inherits Bun's native process environment.
        env.NODE_CHANNEL_FD = '';
        delete env.BASH_XTRACEFD; delete env.BASH_ENV; delete env.ENV; delete env.ELECTRON_RUN_AS_NODE;
        stripAppImageArgv0Leak(env);
        const launch = resolveLinuxPtyLaunch(executable, args);
        const options = { name: 'xterm-256color', cwd, cols, rows, env, ...(process.platform === 'win32' ? { useConpty: true } : {}) };
        return { process: provider.spawn(launch.executable, launch.args, options), backend: provider.backend, shell: resolvedShell.id, loginShell };
      } catch (error) { lastError = error; }
    }
    throw lastError ?? new Error('No executable shell found');
  };

  const killProcess = (ptyProcess: PtyProcess | null, force = false): void => {
    if (!ptyProcess) return;
    const pid = ptyProcess.pid;
    if (process.platform !== 'win32' && typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
      try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already gone */ }
    }
    try { ptyProcess.kill(force ? 'SIGKILL' : undefined); } catch { /* already gone */ }
  };

  const terminateProcess = (ptyProcess: PtyProcess | null, force = false): Promise<void> => {
    if (!ptyProcess) return Promise.resolve();
    if (force) { killProcess(ptyProcess, true); return Promise.resolve(); }
    const completion = new Promise<void>((resolve) => {
      let settled = false;
      let disposable: { dispose?(): void } | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        disposable?.dispose?.();
        resolve();
      };
      const timeout = setTimeout(() => { killProcess(ptyProcess, true); finish(); }, terminalTerminationGraceMs);
      try { disposable = ptyProcess.onExit(() => finish()); } catch { /* backend is already gone */ }
      killProcess(ptyProcess, false);
    });
    const termination = completion.finally(() => pendingTerminations.delete(termination));
    pendingTerminations.add(termination);
    return termination;
  };

  const send = (socket: WebSocket, message: unknown): boolean => {
    if (socket?.readyState !== 1) return false;
    try { socket.send(createTerminalWsControlFrame(message), { binary: true }); return true; } catch { return false; }
  };

  const closeAttachments = (sessionId: string, code: string, message: string): void => {
    for (const connection of connections) {
      if (!connection.attachments.delete(sessionId)) continue;
      send(connection.socket, { t: 'error', v: 3, s: sessionId, code, message, fatal: true });
    }
  };

  const snapshot = (session: TerminalSession): Record<string, unknown> => ({
    t: 'snapshot', v: 3, s: session.id, q: session.sequence, history: session.history,
    status: session.status, exitCode: session.exitCode, signal: session.signal,
    runtime, ptyBackend: session.backend,
  });

  const publish = (session: TerminalSession, event: Record<string, unknown>): void => {
    session.sequence += 1;
    const message = { ...event, v: 3, s: session.id, q: session.sequence };
    for (const connection of connections) {
      const attachment = connection.attachments.get(session.id);
      if (!attachment) continue;
      if (attachment.initializing) attachment.pending.push(message);
      else send(connection.socket, message);
    }
  };

  const drainEvents = (session: TerminalSession): void => {
    if (session.draining) return;
    session.draining = true;
    try {
      while (session.eventQueue.length > 0) {
        const event = session.eventQueue.shift();
        if (!event) break;
        if (event.process !== session.process) continue;
        if (event.type === 'output') {
          const theme = consumeTerminalThemeQueries(session.pendingThemeControlSequence, event.data, {
            themeMode: session.themeMode,
            background: session.terminalBackground,
            foreground: session.terminalForeground,
            modeEnabled: session.themeModeEnabled,
          });
          session.pendingThemeControlSequence = theme.pending;
          session.themeModeEnabled = theme.modeEnabled;
          for (const response of theme.responses) session.process?.write(response);
          const sanitized = sanitizeTerminalHistoryChunk(session.pendingHistoryControlSequence, event.data);
          session.pendingHistoryControlSequence = sanitized.pending;
          session.history = trimHistory(session.history + sanitized.visible);
          session.lastActivity = Date.now();
          publish(session, { t: 'output', d: event.data, ...(sanitized.visible !== event.data ? { r: sanitized.visible } : {}) });
        } else {
          session.status = 'exited';
          session.exitCode = Number.isInteger(event.exitCode) ? event.exitCode : null;
          session.signal = Number.isInteger(event.signal) ? event.signal : null;
          session.process = null;
          if (session.writerState === event.writerState) session.writerState = null;
          void releaseWriterState(event.writerState);
          publish(session, { t: 'exit', exitCode: session.exitCode, signal: session.signal });
        }
      }
    } finally { session.draining = false; }
  };

  const wire = (session: TerminalSession, ptyProcess: PtyProcess, writerState: WriterState): void => {
    ptyProcess.onData((data) => { session.eventQueue.push({ type: 'output', process: ptyProcess, writerState, data }); drainEvents(session); });
    ptyProcess.onExit(({ exitCode, signal }) => { session.eventQueue.push({ type: 'exit', process: ptyProcess, writerState, exitCode, signal }); drainEvents(session); });
  };

  const resolveTerminalWorkingDirectory = async ({ cwd, workspacePath }: {
    cwd?: unknown;
    workspacePath?: unknown;
  }): Promise<string> => {
    const config = createWorkspaceConfig({ env: process.env, pathModule: path });

    if (workspacePath !== undefined && workspacePath !== null) {
      await ensureWorkspaceRoot(config, fs.promises);
      const resolved = await resolveWorkspacePath(String(workspacePath), {
        root: config.root,
        fsPromises: fs.promises,
        pathModule: path,
      });
      const stats = await fs.promises.stat(resolved.absolutePath);
      if (!stats.isDirectory()) throw new Error('Invalid working directory: not a directory');
      return resolved.absolutePath;
    }

    if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('cwd is required');
    if (config.lockdown) {
      const resolved = await assertAbsolutePathInWorkspace(String(cwd), {
        root: config.root,
        fsPromises: fs.promises,
        pathModule: path,
      });
      const stats = await fs.promises.stat(resolved.absolutePath);
      if (!stats.isDirectory()) throw new Error('Invalid working directory: not a directory');
      return resolved.absolutePath;
    }

    const resolvedCwd = path.resolve(String(cwd));
    const stats = await fs.promises.stat(resolvedCwd).catch(() => null);
    if (!stats?.isDirectory()) throw new Error('Invalid working directory');
    return resolvedCwd;
  };

  const validateCwd = async (cwd: string): Promise<void> => {
    const stats = await fs.promises.stat(cwd).catch(() => null);
    if (!stats?.isDirectory()) throw new Error('Invalid working directory');
  };

  const spawnSessionProcess = async (session: TerminalSession, {
    cwd, cols, rows, themeMode, shell, loginShell,
  }: StartSessionInput) => {
    const generation = (session.writerGeneration ?? 0) + 1;
    const writerState: WriterState = { writer: null, released: false };
    let spawned: Awaited<ReturnType<typeof spawnPty>> | null = null;
    try {
      writerState.writer = await acquireWriter(cwd, {
        kind: 'terminal',
        id: session.id,
        generation,
      });
      spawned = await spawnPty({ cwd, cols, rows, themeMode, shell, loginShell });
      return { ...spawned, writerState, generation };
    } catch (error) {
      await releaseWriterState(writerState, Boolean(spawned));
      throw error;
    }
  };

  const applyAppearance = (session: TerminalSession, { themeMode, terminalBackground, terminalForeground }: {
    terminalBackground?: unknown;
    terminalForeground?: unknown;
    themeMode?: unknown;
  }): void => {
    const previous = [session.themeMode, session.terminalBackground, session.terminalForeground];
    if (themeMode === 'light' || themeMode === 'dark') session.themeMode = themeMode;
    if (typeof terminalBackground === 'string') session.terminalBackground = terminalBackground;
    if (typeof terminalForeground === 'string') session.terminalForeground = terminalForeground;
    const changed = previous[0] !== session.themeMode || previous[1] !== session.terminalBackground || previous[2] !== session.terminalForeground;
    if (changed && session.themeModeEnabled) {
      try { session.process?.write(terminalThemeModeReport(session.themeMode)); } catch { /* process exited */ }
    }
  };

  const startSession = async (session: TerminalSession, {
    cwd, cols, rows, themeMode = 'dark', terminalBackground, terminalForeground, shell, loginShell,
  }: StartSessionInput, clear = true): Promise<void> => {
    await validateCwd(cwd);
    const spawned = await spawnSessionProcess(session, { cwd, cols, rows, themeMode, shell, loginShell });
    if (clear) { session.history = ''; session.pendingHistoryControlSequence = ''; session.pendingThemeControlSequence = ''; session.themeModeEnabled = false; }
    session.cwd = cwd; session.cols = cols; session.rows = rows; session.process = spawned.process;
    session.writerState = spawned.writerState; session.writerGeneration = spawned.generation;
    session.backend = spawned.backend; session.shell = spawned.shell; session.loginShell = spawned.loginShell; session.status = 'running'; session.exitCode = null; session.signal = null;
    session.themeMode = themeMode === 'light' ? 'light' : 'dark';
    session.terminalBackground = typeof terminalBackground === 'string' ? terminalBackground : session.terminalBackground;
    session.terminalForeground = typeof terminalForeground === 'string' ? terminalForeground : session.terminalForeground;
    session.lastActivity = Date.now(); session.eventQueue.length = 0;
    wire(session, spawned.process, spawned.writerState);
  };

  const createSession = async (value: unknown): Promise<TerminalSession> => {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const { sessionId, cwd, workspacePath, cols = 80, rows = 24, themeMode, terminalBackground, terminalForeground, shell = 'auto', loginShell = false } = input;
    if (!validateSize(cols, 1000) || !validateSize(rows, 500)) throw new Error('Invalid terminal dimensions');
    if (typeof loginShell !== 'boolean') throw new Error('Invalid terminal login mode');
    const normalizedShell = normalizeTerminalShell(shell);
    if (!normalizedShell) throw new Error('Invalid terminal shell');
    const id = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : randomUUID();
    if (id.length > 128) throw new Error('Invalid terminal session id');
    const existing = sessions.get(id);
    const resolvedCwd = await resolveTerminalWorkingDirectory({ cwd, workspacePath });
    if (existing?.status === 'running') {
      if (path.resolve(existing.cwd) !== resolvedCwd) throw new Error('Terminal session belongs to a different working directory');
      applyAppearance(existing, { themeMode, terminalBackground, terminalForeground });
      return existing;
    }
    const pending = pendingSessionCreates.get(id);
    if (pending) {
      if (pending.cwd !== resolvedCwd) throw new Error('Terminal session belongs to a different working directory');
      if (pending.shell !== normalizedShell) throw new Error('Terminal session is already being created with a different shell');
      if (pending.loginShell !== loginShell) throw new Error('Terminal session is already being created with a different login mode');
      const session = await pending.promise;
      applyAppearance(session, { themeMode, terminalBackground, terminalForeground });
      return session;
    }
    if (!existing && sessions.size + pendingSessionCreates.size >= MAX_SESSIONS) throw new Error('Maximum terminal sessions reached');
    const creation = (async () => {
      const session: TerminalSession = existing ?? {
        id,
        cols,
        cwd: resolvedCwd,
        sequence: 0,
        history: '',
        pendingHistoryControlSequence: '',
        pendingThemeControlSequence: '',
        eventQueue: [],
        draining: false,
        exitCode: null,
        lastActivity: Date.now(),
        loginShell,
        process: null,
        rows,
        shell: normalizedShell,
        signal: null,
        status: 'exited',
        terminalBackground: '',
        terminalForeground: '',
        themeMode: themeMode === 'light' ? 'light' : 'dark',
        themeModeEnabled: false,
        writerState: null,
        writerGeneration: 0,
      };
      await startSession(session, { cwd: resolvedCwd, cols, rows, themeMode, terminalBackground, terminalForeground, shell: normalizedShell, loginShell });
      sessions.set(id, session);
      return session;
    })();
    const pendingEntry = { cwd: resolvedCwd, shell: normalizedShell, loginShell, promise: creation };
    pendingSessionCreates.set(id, pendingEntry);
    try { return await creation; }
    finally { if (pendingSessionCreates.get(id) === pendingEntry) pendingSessionCreates.delete(id); }
  };

  const activeWsServer = wsServer;
  activeWsServer.on('connection', (socket) => {
    const connection: TerminalConnection = { socket, attachments: new Map() };
    connections.add(connection);
    send(socket, { t: 'hello', v: 3 });
    const heartbeat = setInterval(() => { try { socket.ping(); } catch { /* closed */ } }, TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS);
    socket.on('message', (raw, isBinary) => {
      if (!isBinary) { send(socket, { t: 'error', v: 3, code: 'BAD_FRAME', message: 'Binary control frame required', fatal: false }); return; }
      const message = readTerminalWsControlFrame(raw);
      if (!message || message.v !== 3 || typeof message.t !== 'string') { send(socket, { t: 'error', v: 3, code: 'BAD_FRAME', message: 'Invalid terminal frame', fatal: false }); return; }
      if (message.t === 'ping') { send(socket, { t: 'pong', v: 3 }); return; }
      if (message.t === 'hello') return;
      const id = typeof message.s === 'string' ? message.s : '';
      if (!id) { send(socket, { t: 'error', v: 3, code: 'BAD_FRAME', message: 'Session id required', fatal: false }); return; }
      if (message.t === 'detach') { connection.attachments.delete(id); return; }
      const session = sessions.get(id);
      if (!session) { send(socket, { t: 'error', v: 3, s: id, code: 'SESSION_NOT_FOUND', message: 'Terminal session not found', fatal: true }); return; }
      if (message.t === 'attach') {
        const attachment: TerminalAttachment = { initializing: true, pending: [] };
        connection.attachments.set(id, attachment);
        const initial = snapshot(session);
        send(socket, initial);
        for (const event of attachment.pending) {
          if (typeof event.q === 'number' && typeof initial.q === 'number' && event.q > initial.q) send(socket, event);
        }
        attachment.pending.length = 0; attachment.initializing = false;
        return;
      }
      if (message.t === 'write') {
        if (typeof message.d !== 'string' || !message.d || message.d.length > MAX_INPUT_CHARS) { send(socket, { t: 'error', v: 3, s: id, code: 'BAD_INPUT', message: 'Invalid terminal input', fatal: false }); return; }
        if (session.status !== 'running' || !session.process) { send(socket, { t: 'error', v: 3, s: id, code: 'NOT_RUNNING', message: 'Terminal is not running', fatal: false }); return; }
        try { session.process.write(message.d); session.lastActivity = Date.now(); } catch { send(socket, { t: 'error', v: 3, s: id, code: 'WRITE_FAILED', message: 'Failed to write to terminal', fatal: false }); }
      }
    });
    const cleanup = () => { clearInterval(heartbeat); connection.attachments.clear(); connections.delete(connection); };
    socket.on('close', cleanup); socket.on('error', () => {});
  });

  const upgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (parseRequestPathname(req.url) !== TERMINAL_WS_PATH) return;
    void (async () => {
      try {
        if (uiAuthController?.enabled) {
          if (!await uiAuthController.ensureSessionToken(req, null)) { rejectWebSocketUpgrade(socket, 401, 'UI authentication required'); return; }
          if (!await isRequestOriginAllowed(req)) { rejectWebSocketUpgrade(socket, 403, 'Invalid origin'); return; }
        }
        if (!wsServer) { rejectWebSocketUpgrade(socket, 500, 'Terminal WebSocket unavailable'); return; }
        activeWsServer.handleUpgrade(req, socket, head, (ws) => activeWsServer.emit('connection', ws, req));
      } catch { rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'); }
    })();
  };
  server.on('upgrade', upgradeHandler);

  app.get('/api/terminal/shells', async (_req: Request, res: Response) => {
    try {
      const shells = await shellResolver.list();
      res.json(shells.map(({ id, name, supportsLogin }) => ({ id, name, supportsLogin })));
    } catch (error) {
      res.status(500).json({ error: errorMessage(error, 'Failed to list terminal shells') });
    }
  });
  app.post('/api/terminal/create', async (req, res) => {
    try { const session = await createSession(req.body ?? {}); res.json({ sessionId: session.id, cols: session.cols, rows: session.rows, status: session.status }); }
    catch (error) {
      const record = errorRecord(error);
      const statusCode = typeof record.statusCode === 'number'
        ? record.statusCode
        : error instanceof Error && error.message === 'Maximum terminal sessions reached' ? 429 : 400;
      res.status(statusCode).json({ error: errorMessage(error, 'Failed to create terminal session') });
    }
  });
  app.post('/api/terminal/:sessionId/resize', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Terminal session not found' });
    const { cols, rows } = req.body ?? {};
    if (!validateSize(cols, 1000) || !validateSize(rows, 500)) return res.status(400).json({ error: 'Invalid terminal dimensions' });
    try { if (session.status === 'running') session.process?.resize(cols, rows); session.cols = cols; session.rows = rows; res.json({ success: true, cols, rows }); }
    catch (error) { res.status(500).json({ error: errorMessage(error, 'Failed to resize terminal') }); }
  });
  app.post('/api/terminal/:sessionId/appearance', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Terminal session not found' });
    applyAppearance(session, req.body ?? {});
    res.json({ success: true });
  });
  app.post('/api/terminal/:sessionId/restart', async (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Terminal session not found' });
    const cwd = req.body?.cwd ?? session.cwd;
    const workspacePath = req.body?.workspacePath;
    const cols = req.body?.cols ?? session.cols;
    const rows = req.body?.rows ?? session.rows;
    const themeMode = req.body?.themeMode ?? session.themeMode;
    const terminalBackground = req.body?.terminalBackground ?? session.terminalBackground;
    const terminalForeground = req.body?.terminalForeground ?? session.terminalForeground;
    const shell = req.body?.shell ?? 'auto';
    const loginShell = req.body?.loginShell ?? false;
    const previousRestart = pendingSessionRestarts.get(session.id) ?? Promise.resolve();
    const restart = previousRestart.catch(() => {}).then(async () => {
      const resolvedCwd = await resolveTerminalWorkingDirectory({ cwd, workspacePath });
      if (!validateSize(cols, 1000) || !validateSize(rows, 500)) throw new Error('Invalid terminal dimensions');
      if (typeof loginShell !== 'boolean') throw new Error('Invalid terminal login mode');
      const oldProcess = session.process;
      const oldWriterState = session.writerState;
      const spawned = await spawnSessionProcess(session, { cwd: resolvedCwd, cols, rows, themeMode, shell, loginShell });
      session.process = spawned.process; session.backend = spawned.backend; session.shell = spawned.shell; session.loginShell = spawned.loginShell; session.cwd = resolvedCwd; session.cols = cols; session.rows = rows;
      session.writerState = spawned.writerState; session.writerGeneration = spawned.generation;
      session.history = ''; session.pendingHistoryControlSequence = ''; session.pendingThemeControlSequence = ''; session.themeModeEnabled = false; session.status = 'running'; session.exitCode = null; session.signal = null; session.eventQueue.length = 0;
      session.themeMode = themeMode === 'light' ? 'light' : 'dark'; session.terminalBackground = terminalBackground; session.terminalForeground = terminalForeground;
      wire(session, spawned.process, spawned.writerState);
      void terminateProcess(oldProcess).then(() => releaseWriterState(oldWriterState));
      publish(session, { t: 'restarted', history: '' });
    });
    pendingSessionRestarts.set(session.id, restart);
    try {
      await restart;
      res.json({ sessionId: session.id, cols, rows, status: session.status });
    } catch (error) {
      const record = errorRecord(error);
      res.status(typeof record.statusCode === 'number' ? record.statusCode : 400)
        .json({ error: errorMessage(error, 'Failed to restart terminal') });
    }
    finally { if (pendingSessionRestarts.get(session.id) === restart) pendingSessionRestarts.delete(session.id); }
  });
  app.delete('/api/terminal/:sessionId', async (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Terminal session not found' });
    sessions.delete(session.id);
    closeAttachments(session.id, 'CLOSED', 'Terminal closed');
    const processToTerminate = session.process;
    const writerState = session.writerState;
    session.process = null;
    session.writerState = null;
    await terminateProcess(processToTerminate);
    await releaseWriterState(writerState);
    res.json({ success: true });
  });
  app.post('/api/terminal/force-kill', (req, res) => {
    const { sessionId, cwd } = req.body ?? {}; let killedCount = 0;
    const resolvedCwd = cwd ? path.resolve(String(cwd)) : null;
    const killedSessionIds: string[] = [];
    for (const [id, session] of sessions) {
      if ((sessionId && id !== sessionId) || (!sessionId && resolvedCwd && path.resolve(session.cwd) !== resolvedCwd)) continue;
      sessions.delete(id); closeAttachments(id, 'KILLED', 'Terminal was killed');
      const processToTerminate = session.process;
      const writerState = session.writerState;
      session.process = null;
      session.writerState = null;
      void terminateProcess(processToTerminate, true).then(() => releaseWriterState(writerState));
      killedSessionIds.push(id); killedCount += 1;
    }
    res.json({ success: true, killedCount, killedSessionIds });
  });

  const idleSweep = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      const attached = [...connections].some((connection) => connection.attachments.has(id));
      if (!attached && now - session.lastActivity > IDLE_TIMEOUT_MS) {
        sessions.delete(id); closeAttachments(id, 'IDLE_TIMEOUT', 'Terminal expired after being idle');
        const processToTerminate = session.process;
        const writerState = session.writerState;
        session.process = null;
        session.writerState = null;
        void terminateProcess(processToTerminate, true).then(() => releaseWriterState(writerState));
      }
    }
  }, 5 * 60 * 1000);

  const shutdown = async (): Promise<void> => {
    server.off('upgrade', upgradeHandler); clearInterval(idleSweep);
    await Promise.allSettled([...pendingSessionRestarts.values()]);
    const terminations: Promise<void>[] = [];
    for (const session of sessions.values()) {
      const processToTerminate = session.process;
      const writerState = session.writerState;
      session.process = null;
      session.writerState = null;
      terminations.push(terminateProcess(processToTerminate, true).then(() => releaseWriterState(writerState)));
    }
    sessions.clear();
    await Promise.allSettled(terminations);
    await Promise.allSettled([...pendingTerminations]);
    if (!wsServer) return;
    for (const client of wsServer.clients) client.terminate();
    await Promise.race([
      new Promise<void>((resolve) => wsServer?.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]);
    wsServer = null;
  };
  return { shutdown };
}
