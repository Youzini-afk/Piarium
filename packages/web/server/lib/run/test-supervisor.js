import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createJsonRpcClient } from '../lsp/jsonrpc.js';
import { walkWorkspaceTestFiles } from './walk.js';

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

const parseTap = (text, resourceId) => {
  const results = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const ok = /^ok\s+\d+\s+-?\s*(.*)$/.exec(line);
    const notOk = /^not ok\s+\d+\s+-?\s*(.*)$/.exec(line);
    if (ok) {
      results.push({
        id: `${resourceId}:${results.length + 1}`,
        label: ok[1]?.trim() || resourceId,
        resourceId,
        status: 'passed',
      });
    } else if (notOk) {
      results.push({
        id: `${resourceId}:${results.length + 1}`,
        label: notOk[1]?.trim() || resourceId,
        resourceId,
        status: 'failed',
        message: notOk[1]?.trim() || 'Test failed',
      });
    }
  }
  return results;
};

const workspaceIdOf = (value) => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.workspaceId === 'string') return value.workspaceId;
  return '';
};

export const createTestSupervisor = ({
  documents,
  spawn,
  pathModule = path,
  env = process.env,
  isTrusted = async () => false,
  execPath = process.execPath,
  fsPromises = fs.promises,
}) => {
  const providers = [];
  const sessions = new Map();
  const trees = new Map();
  const workspaceListeners = new Map();
  const pendingExits = new Set();
  const generations = new Map();

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
      runId: record.runId,
      generation: record.generation,
    };
    if (record.providerId) snapshot.providerId = record.providerId;
    if (record.message) snapshot.message = record.message;
    return snapshot;
  };

  const findProvider = (workspaceId, providerId) => {
    if (providerId) return providers.find((item) => item.providerId === providerId) ?? null;
    return providers.find((item) => (
      item.source === 'builtin' && (!item.workspaceId || item.workspaceId === workspaceId)
    )) ?? providers.find((item) => !item.workspaceId || item.workspaceId === workspaceId) ?? null;
  };

  const disposeChild = (record) => {
    if (!record?.child) return;
    try {
      record.rpc?.notify('cancel');
    } catch {
      // Provider may already have exited.
    }
    record.rpc?.dispose();
    record.rpc = null;
    const child = record.child;
    try {
      child.kill();
    } catch {
      // Process may already have exited.
    }
    const exited = waitForChildExit(child).finally(() => pendingExits.delete(exited));
    pendingExits.add(exited);
    record.child = null;
  };

  const discoverBuiltin = async (workspace) => {
    const files = await walkWorkspaceTestFiles({
      root: workspace.root,
      fsPromises,
      pathModule,
    });
    return files.map((resourceId) => ({
      id: resourceId,
      label: resourceId,
      resourceId,
    }));
  };

  const startProviderProcess = async (provider, workspace) => {
    const child = spawn(provider.command, provider.args ?? [], {
      cwd: workspace.root,
      env: { ...env, ...provider.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rpc = createJsonRpcClient({ input: child.stdout, output: child.stdin });
    child.stderr?.on('data', () => {});
    const exited = new Promise((_, reject) => {
      child.once('exit', (code) => {
        rpc.rejectAll(new Error('Test provider exited'));
        reject(new Error(`Test provider exited${code === null ? '' : ` with code ${code}`}`));
      });
    });
    exited.catch(() => {});
    try {
      await Promise.race([
        (async () => {
          await rpc.request('initialize', {});
          rpc.notify('initialized');
          await new Promise((resolve) => setTimeout(resolve, 30));
        })(),
        exited,
      ]);
    } catch (error) {
      try { child.kill(); } catch { /* already gone */ }
      throw error;
    }
    return { child, rpc };
  };

  const discover = async (request) => {
    const workspaceId = typeof request?.workspaceId === 'string' ? request.workspaceId : request;
    const provider = findProvider(workspaceId, request?.providerId);
    if (!provider) {
      return { status: 'absent', workspaceId, tests: [] };
    }
    let workspace;
    try {
      workspace = await documents.inspectWorkspace(workspaceId);
    } catch (error) {
      return {
        status: 'failure',
        workspaceId,
        message: error instanceof Error ? error.message : 'Workspace is unavailable',
        tests: [],
      };
    }
    if (provider.source === 'workspace' && !await isTrusted(workspace.root)) {
      return {
        status: 'failure',
        workspaceId,
        message: 'Untrusted workspace cannot execute project-provided test providers',
        tests: [],
      };
    }
    if (provider.kind === 'node-test') {
      const tests = await discoverBuiltin(workspace);
      trees.set(workspaceId, tests);
      return { status: tests.length > 0 ? 'ready' : 'empty', workspaceId, tests };
    }
    let processPair;
    try {
      processPair = await startProviderProcess(provider, workspace);
    } catch (error) {
      return {
        status: 'failure',
        workspaceId,
        message: error instanceof Error ? error.message : 'Failed to start test provider',
        tests: [],
      };
    }
    try {
      const raw = await processPair.rpc.request('discover');
      const tests = Array.isArray(raw?.tests) ? raw.tests.map((item) => {
        const mapped = {
          id: typeof item?.id === 'string' ? item.id : '',
          label: typeof item?.label === 'string' ? item.label : '',
        };
        if (typeof item?.resourceId === 'string') mapped.resourceId = item.resourceId;
        if (Number.isFinite(item?.line)) mapped.line = item.line;
        return mapped;
      }).filter((item) => item.id) : [];
      trees.set(workspaceId, tests);
      return { status: tests.length > 0 ? 'ready' : 'empty', workspaceId, tests };
    } catch (error) {
      return {
        status: 'failure',
        workspaceId,
        message: error instanceof Error ? error.message : 'Test discovery failed',
        tests: [],
      };
    } finally {
      try {
        processPair.rpc.notify('shutdown');
      } catch {
        // Ignore.
      }
      processPair.rpc.dispose();
      try {
        processPair.child.kill();
      } catch {
        // Ignore.
      }
      await waitForChildExit(processPair.child);
    }
  };

  const runNodeTests = async (record, workspace, testIds) => {
    const discovered = trees.get(record.workspaceId) ?? await discoverBuiltin(workspace);
    trees.set(record.workspaceId, discovered);
    const selected = testIds.length > 0
      ? discovered.filter((item) => testIds.includes(item.id) || testIds.includes(item.resourceId))
      : discovered;
    const results = [];
    for (const item of selected) {
      emit(record.workspaceId, { kind: 'test', test: { ...item, status: 'running' } });
      const filePath = pathModule.join(workspace.root, item.resourceId);
      const chunks = [];
      const child = spawn(execPath, ['--test', '--test-reporter=tap', filePath], {
        cwd: workspace.root,
        env: { ...env, NODE_OPTIONS: '' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      record.child = child;
      child.stdout?.on('data', (chunk) => {
        chunks.push(chunk.toString('utf8'));
        emit(record.workspaceId, { kind: 'output', channel: 'test', runId: record.runId, text: chunk.toString('utf8') });
      });
      child.stderr?.on('data', (chunk) => {
        emit(record.workspaceId, { kind: 'output', channel: 'test', runId: record.runId, text: chunk.toString('utf8') });
      });
      const code = await new Promise((resolve) => {
        child.once('exit', (exitCode) => resolve(exitCode ?? 1));
      });
      record.child = null;
      const parsed = parseTap(chunks.join(''), item.resourceId);
      if (parsed.length === 0) {
        const fallback = {
          ...item,
          status: code === 0 ? 'passed' : 'failed',
          ...(code === 0 ? {} : { message: `Test process exited with code ${code}` }),
        };
        results.push(fallback);
        emit(record.workspaceId, { kind: 'test', test: fallback });
      } else {
        for (const result of parsed) {
          results.push(result);
          emit(record.workspaceId, { kind: 'test', test: result });
        }
      }
    }
    record.status = results.some((item) => item.status === 'failed') ? 'failed' : 'stopped';
    emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
    emit(record.workspaceId, { kind: 'finished', results });
    return snapshotFor(record);
  };

  const runProvider = async (record, provider, workspace, testIds) => {
    const processPair = await startProviderProcess(provider, workspace);
    record.child = processPair.child;
    record.rpc = processPair.rpc;
    processPair.child.on('exit', (code) => {
      if (record.child !== processPair.child) return;
      record.child = null;
      record.rpc = null;
      if (record.status === 'running') {
        record.status = 'failed';
        record.message = `Test provider exited${code === null ? '' : ` with code ${code}`}`;
        emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
      }
    });
    processPair.rpc.onNotification((method, params) => {
      if (method === 'test/started' && params?.id) {
        emit(record.workspaceId, { kind: 'test', test: { id: params.id, label: params.label ?? params.id, status: 'running' } });
      }
      if (method === 'test/passed' && params?.id) {
        emit(record.workspaceId, { kind: 'test', test: { id: params.id, label: params.label ?? params.id, status: 'passed' } });
      }
      if (method === 'test/failed' && params?.id) {
        const test = {
          id: params.id,
          label: typeof params.label === 'string' ? params.label : params.id,
          status: 'failed',
        };
        if (typeof params.resourceId === 'string') test.resourceId = params.resourceId;
        if (Number.isFinite(params.line)) test.line = params.line;
        if (typeof params.message === 'string') test.message = params.message;
        if (typeof params.stack === 'string') test.stack = params.stack;
        emit(record.workspaceId, { kind: 'test', test });
      }
      if (method === 'test/finished') {
        record.status = params?.status === 'failed' ? 'failed' : 'stopped';
        emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
        emit(record.workspaceId, { kind: 'finished' });
      }
    });
    await processPair.rpc.request('run', { testIds });
    return snapshotFor(record);
  };

  const run = async (request) => {
    const workspaceId = typeof request?.workspaceId === 'string' ? request.workspaceId : '';
    const provider = findProvider(workspaceId, request?.providerId);
    if (!provider) return { status: 'absent', workspaceId };
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
    if (provider.source === 'workspace' && !await isTrusted(workspace.root)) {
      return {
        status: 'failed',
        workspaceId,
        message: 'Untrusted workspace cannot execute project-provided test providers',
      };
    }
    const existing = sessions.get(workspaceId);
    if (existing) {
      disposeChild(existing);
      sessions.delete(workspaceId);
    }
    const record = {
      workspaceId,
      runId: randomUUID(),
      providerId: provider.providerId,
      generation: nextGeneration(workspaceId),
      status: 'running',
      message: '',
      child: null,
      rpc: null,
    };
    sessions.set(workspaceId, record);
    emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
    const testIds = Array.isArray(request?.testIds) ? request.testIds.filter((id) => typeof id === 'string') : [];
    try {
      if (provider.kind === 'node-test') return await runNodeTests(record, workspace, testIds);
      return await runProvider(record, provider, workspace, testIds);
    } catch (error) {
      record.status = 'failed';
      record.message = error instanceof Error ? error.message : 'Test run failed';
      emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
      disposeChild(record);
      return snapshotFor(record);
    }
  };

  return {
    registerProvider(descriptor) {
      if (!descriptor?.providerId) throw new Error('Test provider requires providerId');
      const next = {
        providerId: descriptor.providerId,
        kind: descriptor.kind === 'node-test' ? 'node-test' : 'adapter',
        command: typeof descriptor.command === 'string' ? descriptor.command : '',
        args: Array.isArray(descriptor.args) ? descriptor.args : [],
        source: descriptor.source === 'workspace' || descriptor.source === 'extension' || descriptor.source === 'builtin'
          ? descriptor.source
          : 'host',
      };
      if (typeof descriptor.workspaceId === 'string' && descriptor.workspaceId) {
        next.workspaceId = descriptor.workspaceId;
      }
      if (descriptor.env && typeof descriptor.env === 'object') next.env = descriptor.env;
      if (next.kind === 'adapter' && !next.command) {
        throw new Error('Test provider requires command');
      }
      providers.push(next);
      return { status: 'registered', providerId: next.providerId };
    },
    async unregisterProvider(providerId) {
      const index = providers.findIndex((item) => item.providerId === providerId);
      if (index >= 0) providers.splice(index, 1);
      for (const [workspaceId, record] of sessions) {
        if (record.providerId !== providerId) continue;
        disposeChild(record);
        record.status = 'stopped';
        record.message = 'Test provider disabled';
        emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
        sessions.delete(workspaceId);
        trees.delete(workspaceId);
      }
      await Promise.all([...pendingExits]);
      return { status: 'unregistered', providerId };
    },
    discover,
    run,
    cancel(request) {
      const workspaceId = workspaceIdOf(request);
      const record = sessions.get(workspaceId);
      if (!record) return { status: 'absent', workspaceId };
      disposeChild(record);
      record.status = 'stopped';
      record.message = 'Test run cancelled';
      emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
      return snapshotFor(record);
    },
    getStatus(request) {
      const workspaceId = workspaceIdOf(request);
      const record = sessions.get(workspaceId);
      if (record) return snapshotFor(record);
      const tests = trees.get(workspaceId);
      if (tests) return { status: tests.length > 0 ? 'idle' : 'empty', workspaceId };
      return { status: 'absent', workspaceId };
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
        disposeChild(record);
        sessions.delete(workspaceId);
      }
      trees.delete(workspaceId);
      workspaceListeners.delete(workspaceId);
      await Promise.all([...pendingExits]);
    },
    async dispose() {
      for (const record of sessions.values()) disposeChild(record);
      sessions.clear();
      providers.length = 0;
      trees.clear();
      workspaceListeners.clear();
      await Promise.all([...pendingExits]);
    },
  };
};
