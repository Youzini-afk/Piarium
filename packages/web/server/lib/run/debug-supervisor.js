import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createDapClient } from './dap.js';
import { resolveWorkspacePath } from '../workspace/path-safety.js';

const ownerScopeKey = (owner) => owner
  ? `${owner.extensionId}\0${owner.entrypointId}`
  : 'piarium.host';
const exactOwnerKey = (owner) => owner
  ? `${ownerScopeKey(owner)}\0${owner.generation}`
  : 'piarium.host\0host';

const waitForChildExit = (child) => new Promise((resolve) => {
  if (!child || child.exitCode !== null || child.signalCode) {
    resolve();
    return;
  }
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve();
  };
  const timer = setTimeout(finish, 3000);
  child.once('exit', finish);
  child.once('close', finish);
});

const relativeFromRoot = (root, absolutePath, pathModule) => {
  const relative = pathModule.relative(root, absolutePath);
  if (!relative || relative.startsWith('..') || pathModule.isAbsolute(relative)) return null;
  return relative.split(pathModule.sep).join('/');
};

const resourceIdFromSource = (source, root, pathModule) => {
  const raw = typeof source?.path === 'string' ? source.path : typeof source === 'string' ? source : '';
  if (!raw) return '';
  if (!pathModule.isAbsolute(raw) && !raw.startsWith('file:')) return raw.replace(/\\/g, '/');
  try {
    const absolute = raw.startsWith('file:') ? fileURLToPath(raw) : raw;
    return relativeFromRoot(root, absolute, pathModule) ?? '';
  } catch {
    return '';
  }
};

const workspaceIdOf = (value) => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.workspaceId === 'string') return value.workspaceId;
  return '';
};

export const createDebugSupervisor = ({
  documents,
  spawn,
  pathModule = path,
  env = process.env,
  isTrusted = async () => false,
}) => {
  const adapters = [];
  const sessions = new Map();
  const breakpoints = new Map();
  const watches = new Map();
  const workspaceListeners = new Map();
  const generations = new Map();
  const pendingExits = new Set();

  const nextGeneration = (workspaceId) => {
    const next = (generations.get(workspaceId) ?? 0) + 1;
    generations.set(workspaceId, next);
    return next;
  };

  const emit = (workspaceId, event) => {
    const listeners = workspaceListeners.get(workspaceId);
    if (!listeners) return;
    for (const listener of listeners) listener(event);
  };

  const snapshotFor = (record) => {
    if (!record) return null;
    const snapshot = {
      status: record.status,
      workspaceId: record.workspaceId,
      sessionId: record.sessionId,
      generation: record.generation,
    };
    if (record.adapterId) snapshot.adapterId = record.adapterId;
    if (record.message) snapshot.message = record.message;
    if (record.reason) snapshot.reason = record.reason;
    return snapshot;
  };

  const findAdapter = (adapterId, languageId) => {
    if (adapterId) return adapters.find((item) => item.adapterId === adapterId) ?? null;
    if (languageId) {
      return adapters.find((item) => item.languageIds.includes(languageId)) ?? null;
    }
    return adapters.find((item) => item.source === 'builtin') ?? adapters[0] ?? null;
  };

  const disposeRecord = (record, reason = 'Debug session stopped') => {
    if (!record) return;
    try {
      void record.rpc?.request('disconnect', { terminateDebuggee: true }).catch(() => undefined);
    } catch {
      // Adapter may already have exited.
    }
    record.rpc?.rejectAll(new Error(reason));
    record.rpc?.dispose();
    record.rpc = null;
    const child = record.child;
    try {
      child?.kill();
    } catch {
      // Process may already have exited.
    }
    if (child) {
      const exited = waitForChildExit(child).finally(() => pendingExits.delete(exited));
      pendingExits.add(exited);
    }
    record.child = null;
    if (record.status === 'starting' || record.status === 'running' || record.status === 'paused') {
      record.status = 'stopped';
      record.message = reason;
      emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
    }
  };

  const setFailed = (record, message) => {
    record.status = 'failed';
    record.message = message;
    emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
  };

  const getStatus = (request) => {
    const workspaceId = workspaceIdOf(request);
    const existing = sessions.get(workspaceId);
    if (existing) return snapshotFor(existing);
    return { status: 'absent', workspaceId };
  };

  const listBreakpoints = (request) => (
    breakpoints.get(workspaceIdOf(request)) ?? []
  );

  const setBreakpoints = (request) => {
    const workspaceId = typeof request?.workspaceId === 'string' ? request.workspaceId : '';
    const resourceId = typeof request?.resourceId === 'string' ? request.resourceId : '';
    const lines = Array.isArray(request?.lines)
      ? [...new Set(request.lines.map((line) => Number(line)).filter((line) => Number.isFinite(line) && line >= 1))].sort((a, b) => a - b)
      : [];
    const current = breakpoints.get(workspaceId) ?? [];
    const next = current.filter((item) => item.resourceId !== resourceId);
    for (const line of lines) next.push({ resourceId, line });
    next.sort((left, right) => left.resourceId.localeCompare(right.resourceId) || left.line - right.line);
    breakpoints.set(workspaceId, next);
    const record = sessions.get(workspaceId);
    if (record?.rpc && (record.status === 'running' || record.status === 'paused')) {
      const program = pathModule.join(record.root, resourceId);
      void record.rpc.request('setBreakpoints', {
        source: { path: program },
        breakpoints: lines.map((line) => ({ line })),
      }).catch(() => {});
    }
    return { status: 'ready', workspaceId, breakpoints: next };
  };

  const start = async (request) => {
    const workspaceId = typeof request?.workspaceId === 'string' ? request.workspaceId : '';
    const existing = sessions.get(workspaceId);
    if (existing) disposeRecord(existing, 'Replaced by a new debug session');
    const adapter = findAdapter(request?.adapterId, request?.languageId);
    if (!adapter) {
      return { status: 'absent', workspaceId, message: 'No debug adapter is registered' };
    }
    let workspace;
    try {
      workspace = await documents.inspectWorkspace(workspaceId);
    } catch (error) {
      return {
        status: 'failed',
        workspaceId,
        message: error instanceof Error ? error.message : 'Workspace is unavailable',
      };
    }
    if (!await isTrusted(workspace.root)) {
      return {
        status: 'failed',
        workspaceId,
        adapterId: adapter.adapterId,
        message: 'Untrusted workspace cannot start debug sessions',
      };
    }
    const programId = typeof request?.program === 'string' ? request.program : '';
    let programPath = '';
    if (programId) {
      try {
        const resolved = await resolveWorkspacePath(programId, {
          root: workspace.root,
          fsPromises: fs.promises,
          pathModule,
        });
        programPath = resolved.realPath;
      } catch (error) {
        return {
          status: 'failed',
          workspaceId,
          message: error instanceof Error ? error.message : 'Debug program is outside the workspace',
        };
      }
    }
    const sessionId = randomUUID();
    const record = {
      workspaceId,
      sessionId,
      adapterId: adapter.adapterId,
      adapterOwnerKey: adapter.ownerKey,
      generation: nextGeneration(workspaceId),
      status: 'starting',
      message: '',
      child: null,
      rpc: null,
      root: workspace.root,
      program: programPath,
    };
    sessions.set(workspaceId, record);
    emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
    let child;
    try {
      child = spawn(adapter.command, adapter.args ?? [], {
        cwd: workspace.root,
        env: { ...env, ...adapter.env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      setFailed(record, error instanceof Error ? error.message : 'Failed to start debug adapter');
      return snapshotFor(record);
    }
    record.child = child;
    const rpc = createDapClient({ input: child.stdout, output: child.stdin });
    record.rpc = rpc;
    rpc.onNotification((method, params) => {
      if (sessions.get(workspaceId) !== record || record.child !== child || record.rpc !== rpc) return;
      if (method === 'stopped') {
        record.status = 'paused';
        if (typeof params?.reason === 'string') record.reason = params.reason;
        emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
        return;
      }
      if (method === 'continued' || method === 'output' || method === 'exited' || method === 'terminated') {
        if (method === 'output' && typeof params?.output === 'string') {
          emit(workspaceId, {
            kind: 'output',
            sessionId,
            channel: 'debug-console',
            text: params.output,
          });
        }
        if (method === 'terminated' || method === 'exited') {
          record.status = 'stopped';
          emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
        }
        if (method === 'continued') {
          record.status = 'running';
          delete record.reason;
          emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
        }
      }
    });
    child.stderr?.on('data', () => {
      // stderr may contain paths; never log adapter payloads.
    });
    child.on('exit', (code) => {
      if (record.child !== child) return;
      rpc.rejectAll(new Error('Debug adapter exited'));
      if (record.status === 'starting' || record.status === 'running' || record.status === 'paused') {
        setFailed(record, `Debug adapter exited${code === null ? '' : ` with code ${code}`}`);
      }
      record.child = null;
      record.rpc = null;
    });
    try {
      const initialized = rpc.waitForEvent('initialized');
      const capabilities = await rpc.request('initialize', {
        adapterID: adapter.adapterId,
        clientID: 'piarium',
        clientName: 'Piarium',
        pathFormat: 'path',
        linesStartAt1: true,
        columnsStartAt1: true,
      });
      const launchParams = { cwd: workspace.root };
      if (programPath) launchParams.program = programPath;
      const launch = rpc.request('launch', launchParams);
      void launch.catch(() => undefined);
      await initialized;
      const grouped = new Map();
      for (const item of listBreakpoints(workspaceId)) {
        const lines = grouped.get(item.resourceId) ?? [];
        lines.push(item.line);
        grouped.set(item.resourceId, lines);
      }
      for (const [resourceId, lines] of grouped) {
        await rpc.request('setBreakpoints', {
          source: { path: pathModule.join(workspace.root, resourceId) },
          breakpoints: lines.map((line) => ({ line })),
        });
      }
      if (capabilities?.supportsConfigurationDoneRequest === true) {
        await rpc.request('configurationDone');
      }
      await launch;
      if (sessions.get(workspaceId) !== record || !adapters.includes(adapter)) {
        disposeRecord(record, 'Debug adapter changed during startup');
        if (sessions.get(workspaceId) === record) sessions.delete(workspaceId);
        return snapshotFor(record);
      }
      if (record.status === 'starting') record.status = 'running';
      emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
      return snapshotFor(record);
    } catch (error) {
      setFailed(record, error instanceof Error ? error.message : 'Failed to initialize debug adapter');
      disposeRecord(record, record.message);
      return snapshotFor(record);
    }
  };

  const withSession = async (workspaceId, action) => {
    const record = sessions.get(workspaceId);
    if (!record?.rpc) {
      return { status: 'absent', workspaceId };
    }
    if (record.status === 'failed' || record.status === 'stopped') {
      return snapshotFor(record);
    }
    try {
      return await action(record);
    } catch (error) {
      if (record.rpc && (record.status === 'running' || record.status === 'paused')) {
        record.status = 'failed';
        record.message = error instanceof Error ? error.message : 'Debug request failed';
        emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
      }
      return {
        status: 'failed',
        workspaceId,
        sessionId: record.sessionId,
        generation: record.generation,
        message: error instanceof Error ? error.message : 'Debug request failed',
      };
    }
  };

  const mapFrame = (frame, root) => {
    const mapped = {
      id: Number(frame?.id) || 0,
      name: typeof frame?.name === 'string' ? frame.name : '(anonymous)',
      line: Number(frame?.line) || 1,
      column: Number(frame?.column) || 1,
    };
    const resourceId = resourceIdFromSource(frame?.source, root, pathModule);
    if (resourceId) mapped.resourceId = resourceId;
    return mapped;
  };

  return {
    registerAdapter(descriptor, owner) {
      const languageIds = Array.isArray(descriptor?.languageIds)
        ? descriptor.languageIds.filter((id) => typeof id === 'string' && id)
        : [];
      if (!descriptor?.adapterId || !descriptor.command) {
        throw new Error('Debug adapter requires adapterId and command');
      }
      const next = {
        adapterId: descriptor.adapterId,
        command: descriptor.command,
        args: Array.isArray(descriptor.args) ? descriptor.args : [],
        languageIds,
        source: owner
          ? 'extension'
          : (descriptor.source === 'workspace' || descriptor.source === 'extension' || descriptor.source === 'builtin'
            ? descriptor.source
            : 'host'),
        ownerScopeKey: ownerScopeKey(owner),
        ownerKey: exactOwnerKey(owner),
      };
      if (typeof descriptor.workspaceId === 'string' && descriptor.workspaceId) {
        next.workspaceId = descriptor.workspaceId;
      }
      if (descriptor.env && typeof descriptor.env === 'object') next.env = descriptor.env;
      const existingIndex = adapters.findIndex((adapter) => adapter.adapterId === next.adapterId);
      const existing = existingIndex >= 0 ? adapters[existingIndex] : null;
      if (existing && existing.ownerScopeKey !== next.ownerScopeKey) {
        throw new Error(`Debug adapter ID is already owned: ${next.adapterId}`);
      }
      if (existingIndex >= 0) adapters.splice(existingIndex, 1, next);
      else adapters.push(next);
      if (existing) {
        for (const [workspaceId, record] of sessions) {
          if (record.adapterId !== existing.adapterId) continue;
          disposeRecord(record, 'Debug adapter updated');
          sessions.delete(workspaceId);
        }
      }
      return { status: 'registered', adapterId: next.adapterId };
    },
    async unregisterAdapter(adapterId, owner) {
      const index = adapters.findIndex((item) => (
        item.adapterId === adapterId && item.ownerKey === exactOwnerKey(owner)
      ));
      if (index < 0) return { status: 'not-owned', adapterId };
      adapters.splice(index, 1);
      for (const [workspaceId, record] of sessions) {
        if (record.adapterId !== adapterId) continue;
        disposeRecord(record, 'Debug adapter disabled');
        sessions.delete(workspaceId);
      }
      await Promise.all([...pendingExits]);
      return { status: 'unregistered', adapterId };
    },
    getStatus,
    listBreakpoints: (workspaceId) => ({
      status: 'ready',
      workspaceId,
      breakpoints: listBreakpoints(workspaceId),
    }),
    setBreakpoints,
    start,
    async stop(request) {
      const workspaceId = typeof request?.workspaceId === 'string' ? request.workspaceId : request;
      const record = sessions.get(workspaceId);
      if (!record) return { status: 'absent', workspaceId };
      disposeRecord(record, 'Debug session stopped');
      sessions.delete(workspaceId);
      await Promise.all([...pendingExits]);
      return snapshotFor(record) ?? { status: 'stopped', workspaceId };
    },
    continue: (request) => withSession(request?.workspaceId, async (record) => {
      await record.rpc.request('continue', { threadId: 1 });
      if (record.status === 'paused' || record.status === 'starting') {
        record.status = 'running';
        delete record.reason;
        emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
      }
      return snapshotFor(record);
    }),
    pause: (request) => withSession(request?.workspaceId, async (record) => {
      await record.rpc.request('pause', { threadId: 1 });
      return snapshotFor(record);
    }),
    stepOver: (request) => withSession(request?.workspaceId, async (record) => {
      await record.rpc.request('next', { threadId: 1 });
      return snapshotFor(record);
    }),
    stepIn: (request) => withSession(request?.workspaceId, async (record) => {
      await record.rpc.request('stepIn', { threadId: 1 });
      return snapshotFor(record);
    }),
    stepOut: (request) => withSession(request?.workspaceId, async (record) => {
      await record.rpc.request('stepOut', { threadId: 1 });
      return snapshotFor(record);
    }),
    getThreads: (request) => withSession(request?.workspaceId ?? request, async (record) => {
      const raw = await record.rpc.request('threads');
      const threads = Array.isArray(raw?.threads) ? raw.threads : [];
      return {
        status: 'ready',
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        generation: record.generation,
        value: threads.map((thread) => ({
          id: Number(thread?.id) || 0,
          name: typeof thread?.name === 'string' ? thread.name : 'thread',
        })),
      };
    }),
    getStack: (request) => withSession(request?.workspaceId, async (record) => {
      const raw = await record.rpc.request('stackTrace', { threadId: Number(request?.threadId) || 1 });
      const frames = Array.isArray(raw?.stackFrames) ? raw.stackFrames : [];
      return {
        status: 'ready',
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        generation: record.generation,
        value: frames.map((frame) => mapFrame(frame, record.root)),
      };
    }),
    getScopes: (request) => withSession(request?.workspaceId, async (record) => {
      const raw = await record.rpc.request('scopes', { frameId: Number(request?.frameId) || 1 });
      const scopes = Array.isArray(raw?.scopes) ? raw.scopes : [];
      return {
        status: 'ready',
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        generation: record.generation,
        value: scopes.map((scope) => {
          const mapped = {
            name: typeof scope?.name === 'string' ? scope.name : 'scope',
            variablesReference: Number(scope?.variablesReference) || 0,
          };
          return mapped;
        }),
      };
    }),
    getVariables: (request) => withSession(request?.workspaceId, async (record) => {
      const raw = await record.rpc.request('variables', {
        variablesReference: Number(request?.variablesReference) || 0,
      });
      const variables = Array.isArray(raw?.variables) ? raw.variables : [];
      return {
        status: 'ready',
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        generation: record.generation,
        value: variables.map((variable) => {
          const mapped = {
            name: typeof variable?.name === 'string' ? variable.name : '',
            value: typeof variable?.value === 'string' ? variable.value : '',
            variablesReference: Number(variable?.variablesReference) || 0,
          };
          if (typeof variable?.type === 'string') mapped.type = variable.type;
          return mapped;
        }).filter((item) => item.name),
      };
    }),
    evaluate: (request) => withSession(request?.workspaceId, async (record) => {
      const expression = typeof request?.expression === 'string' ? request.expression : '';
      const raw = await record.rpc.request('evaluate', {
        expression,
        frameId: Number(request?.frameId) || 1,
        context: 'repl',
      });
      return {
        status: 'ready',
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        generation: record.generation,
        value: typeof raw?.result === 'string' ? raw.result : 'undefined',
      };
    }),
    listWatch: (request) => {
      const workspaceId = workspaceIdOf(request);
      return {
        status: 'ready',
        workspaceId,
        expressions: watches.get(workspaceId) ?? [],
      };
    },
    addWatch(request) {
      const workspaceId = typeof request?.workspaceId === 'string' ? request.workspaceId : '';
      const expression = typeof request?.expression === 'string' ? request.expression.trim() : '';
      if (!expression) return { status: 'failed', workspaceId, message: 'Watch expression is required' };
      const current = watches.get(workspaceId) ?? [];
      if (!current.includes(expression)) current.push(expression);
      watches.set(workspaceId, current);
      return { status: 'ready', workspaceId, expressions: current };
    },
    removeWatch(request) {
      const workspaceId = typeof request?.workspaceId === 'string' ? request.workspaceId : '';
      const expression = typeof request?.expression === 'string' ? request.expression : '';
      const current = (watches.get(workspaceId) ?? []).filter((item) => item !== expression);
      watches.set(workspaceId, current);
      return { status: 'ready', workspaceId, expressions: current };
    },
    subscribe(workspaceId, listener) {
      const listeners = workspaceListeners.get(workspaceId) ?? new Set();
      listeners.add(listener);
      workspaceListeners.set(workspaceId, listeners);
      return {
        close() {
          listeners.delete(listener);
          if (listeners.size === 0) workspaceListeners.delete(workspaceId);
        },
      };
    },
    async disposeWorkspace(request) {
      const workspaceId = workspaceIdOf(request);
      const record = sessions.get(workspaceId);
      if (record) {
        disposeRecord(record, 'Workspace debug session disposed');
        sessions.delete(workspaceId);
      }
      breakpoints.delete(workspaceId);
      watches.delete(workspaceId);
      workspaceListeners.delete(workspaceId);
      await Promise.all([...pendingExits]);
    },
    async dispose() {
      for (const record of sessions.values()) disposeRecord(record, 'Debug supervisor disposed');
      sessions.clear();
      adapters.length = 0;
      breakpoints.clear();
      watches.clear();
      workspaceListeners.clear();
      await Promise.all([...pendingExits]);
    },
  };
};
