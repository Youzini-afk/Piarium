import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveWorkspacePath } from '../workspace/path-safety.js';

const TASKS_FILE = 'piarium.tasks.json';

const workspaceIdOf = (value) => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.workspaceId === 'string') return value.workspaceId;
  return '';
};

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

const registerProcessWriter = async (documents, scopeId, owner, purpose) => {
  if (typeof documents?.registerWriterForScope !== 'function') return null;
  return documents.registerWriterForScope(scopeId, owner, { mode: 'process', purpose });
};

const releaseProcessWriter = async (writer, mutated = true) => {
  if (!writer) return;
  if (mutated) {
    try { await writer.markMutated(); } catch { /* authority may already be gone */ }
  }
  try { await writer.close(); } catch { /* authority may already be gone */ }
};

const asRecord = (value) => (
  value && typeof value === 'object' && !Array.isArray(value) ? value : null
);

const parseTaskDocument = (content) => {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('piarium.tasks.json is malformed');
  }
  const root = asRecord(parsed);
  if (!root) throw new Error('piarium.tasks.json must be an object');
  if (root.version !== 1) throw new Error('piarium.tasks.json version is unsupported');
  if (!Array.isArray(root.tasks)) throw new Error('piarium.tasks.json tasks must be an array');
  const tasks = [];
  for (const item of root.tasks) {
    const record = asRecord(item);
    if (!record || typeof record.id !== 'string' || !record.id.trim()) continue;
    if (typeof record.label !== 'string' || !record.label.trim()) continue;
    const type = record.type === 'process' || record.type === 'npm' ? record.type : 'node';
    const next = {
      id: record.id.trim(),
      label: record.label.trim(),
      type,
    };
    if (typeof record.script === 'string' && record.script.trim()) next.script = record.script.trim();
    if (typeof record.command === 'string' && record.command.trim()) next.command = record.command.trim();
    if (Array.isArray(record.args)) {
      next.args = record.args.filter((value) => typeof value === 'string');
    }
    tasks.push(next);
  }
  return tasks;
};

export const createWorkspaceTaskRunner = ({
  documents,
  spawn,
  pathModule = path,
  env = process.env,
  isTrusted = async () => false,
  execPath = process.execPath,
}) => {
  const runs = new Map();
  const workspaceListeners = new Map();
  const pendingExits = new Set();

  const acquireWriter = (scopeId, owner) => {
    return registerProcessWriter(documents, scopeId, owner, 'task-process');
  };

  const releaseRecordWriter = async (record, mutated = true) => {
    if (!record?.writer || record.writerReleased) return;
    record.writerReleased = true;
    const writer = record.writer;
    record.writer = null;
    await releaseProcessWriter(writer, mutated);
  };

  const emit = (workspaceId, event) => {
    const listeners = workspaceListeners.get(workspaceId);
    if (!listeners) return;
    for (const listener of listeners) listener(event);
  };

  const snapshotFor = (record) => {
    const snapshot = {
      status: record.status,
      workspaceId: record.workspaceId,
      runId: record.runId,
      taskId: record.taskId,
      generation: record.generation,
    };
    if (record.message) snapshot.message = record.message;
    if (typeof record.exitCode === 'number') snapshot.exitCode = record.exitCode;
    return snapshot;
  };

  const disposeRun = (record, reason = 'Task stopped') => {
    if (!record) return;
    const child = record.child;
    try {
      child?.kill();
    } catch {
      // Process may already have exited.
    }
    if (child) {
      const exited = waitForChildExit(child)
        .then(() => releaseRecordWriter(record))
        .finally(() => {
          if (record.pendingTermination === exited) record.pendingTermination = null;
          pendingExits.delete(exited);
        });
      pendingExits.add(exited);
      record.pendingTermination = exited;
    } else if (!record.pendingTermination) void releaseRecordWriter(record);
    record.child = null;
    if (record.status === 'running') {
      record.status = 'stopped';
      record.message = reason;
      emit(record.workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
    }
  };

  const list = async (request) => {
    const workspaceId = workspaceIdOf(request);
    let workspace;
    try {
      workspace = await documents.inspectWorkspace(workspaceId);
    } catch (error) {
      return {
        status: 'failure',
        workspaceId,
        message: error instanceof Error ? error.message : 'Workspace is unavailable',
        configurations: [],
      };
    }
    const resource = { workspaceId, resourceId: TASKS_FILE };
    let read;
    try {
      read = await documents.read(resource);
    } catch (error) {
      return {
        status: 'failure',
        workspaceId,
        message: error instanceof Error ? error.message : 'Failed to read tasks',
        configurations: [],
      };
    }
    if (read.status === 'missing') {
      return { status: 'ready', workspaceId, configurations: [] };
    }
    if (read.status !== 'ready') {
      return {
        status: 'failure',
        workspaceId,
        message: read.status === 'binary' ? 'piarium.tasks.json is not text' : 'Failed to read tasks',
        configurations: [],
      };
    }
    try {
      return {
        status: 'ready',
        workspaceId,
        configurations: parseTaskDocument(read.content),
      };
    } catch (error) {
      return {
        status: 'failure',
        workspaceId,
        message: error instanceof Error ? error.message : 'piarium.tasks.json is malformed',
        configurations: [],
      };
    }
  };

  const run = async (request) => {
    const workspaceId = typeof request?.workspaceId === 'string' ? request.workspaceId : '';
    const taskId = typeof request?.taskId === 'string' ? request.taskId : '';
    const listed = await list(workspaceId);
    if (listed.status !== 'ready') {
      return { status: 'failed', workspaceId, taskId, message: listed.message };
    }
    const task = listed.configurations.find((item) => item.id === taskId);
    if (!task) {
      return { status: 'failed', workspaceId, taskId, message: 'Task configuration was not found' };
    }
    let workspace;
    try {
      workspace = await documents.inspectWorkspace(workspaceId);
    } catch (error) {
      return {
        status: 'failed',
        workspaceId,
        taskId,
        message: error instanceof Error ? error.message : 'Workspace is unavailable',
      };
    }
    if (!await isTrusted(workspace.root)) {
      return {
        status: 'failed',
        workspaceId,
        taskId,
        message: 'Untrusted workspace cannot execute project-provided task commands',
      };
    }
    let command = execPath;
    let args = [];
    if (task.type === 'node') {
      const script = task.script || task.command;
      if (!script) {
        return { status: 'failed', workspaceId, taskId, message: 'Node task requires a script' };
      }
      let resolved;
      try {
        resolved = await resolveWorkspacePath(script, {
          root: workspace.root,
          fsPromises: fs.promises,
          pathModule,
        });
      } catch (error) {
        return {
          status: 'failed',
          workspaceId,
          taskId,
          message: error instanceof Error ? error.message : 'Task script is outside the workspace',
        };
      }
      args = [resolved.realPath];
    } else if (task.type === 'npm') {
      command = 'npm';
      args = ['run', task.script || task.command].filter(Boolean);
    } else {
      command = task.command;
      args = Array.isArray(task.args) ? task.args : [];
      if (!command) {
        return { status: 'failed', workspaceId, taskId, message: 'Process task requires a command' };
      }
    }
    const runId = randomUUID();
    const record = {
      runId,
      workspaceId,
      taskId,
      status: 'running',
      generation: 1,
      message: '',
      child: null,
      writer: null,
      writerReleased: false,
      pendingTermination: null,
    };
    runs.set(runId, record);
    let child;
    try {
      record.writer = await acquireWriter(workspaceId, {
        kind: 'task',
        id: runId,
        generation: record.generation,
      });
      emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
      child = spawn(command, args, {
        cwd: workspace.root,
        env: { ...env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      await releaseRecordWriter(record, Boolean(child));
      record.status = 'failed';
      record.message = error instanceof Error ? error.message : 'Failed to start task';
      emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
      return snapshotFor(record);
    }
    record.child = child;
    child.stdout?.on('data', (chunk) => {
      emit(workspaceId, {
        kind: 'output',
        runId,
        channel: 'task',
        text: chunk.toString('utf8'),
      });
    });
    child.stderr?.on('data', (chunk) => {
      emit(workspaceId, {
        kind: 'output',
        runId,
        channel: 'task',
        text: chunk.toString('utf8'),
      });
    });
    child.on('exit', (code) => {
      if (record.child !== child) return;
      record.child = null;
      record.exitCode = typeof code === 'number' ? code : 0;
      record.status = code === 0 ? 'stopped' : 'failed';
      if (code !== 0) record.message = `Task exited with code ${code}`;
      emit(workspaceId, { kind: 'status', snapshot: snapshotFor(record) });
      void releaseRecordWriter(record);
    });
    return snapshotFor(record);
  };

  return {
    list,
    run,
    cancel(request) {
      const runId = typeof request?.runId === 'string' ? request.runId : '';
      const record = runs.get(runId);
      if (!record || record.workspaceId !== request?.workspaceId) {
        return { status: 'failed', workspaceId: request?.workspaceId, message: 'Task run was not found' };
      }
      disposeRun(record, 'Task cancelled');
      return snapshotFor(record);
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
      for (const [runId, record] of runs) {
        if (record.workspaceId !== workspaceId) continue;
        disposeRun(record, 'Workspace tasks disposed');
        runs.delete(runId);
      }
      workspaceListeners.delete(workspaceId);
      await Promise.all([...pendingExits]);
    },
    async dispose() {
      for (const record of runs.values()) disposeRun(record, 'Task runner disposed');
      runs.clear();
      workspaceListeners.clear();
      await Promise.all([...pendingExits]);
    },
  };
};
