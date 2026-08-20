import { afterEach, describe, expect, test } from 'bun:test';
import type {
  WorkspaceDebugAPI,
  WorkspaceTasksAPI,
  WorkspaceTestAPI,
} from '@/lib/api/types';
import {
  acquireRunDebugView,
  getBoundRunDebugServices,
  isRunDebugViewActive,
  peekLastTestFailure,
  releaseRunDebugView,
  resetRunDebugServices,
  bindRunDebugServices,
} from './session';

const tasks: WorkspaceTasksAPI = {
  list: async (workspaceId) => ({ status: 'ready', workspaceId, configurations: [] }),
  run: async (request) => ({ status: 'running', workspaceId: request.workspaceId, runId: 'run-1' }),
  cancel: async (request) => ({ status: 'stopped', workspaceId: request.workspaceId, runId: request.runId }),
  subscribe() {
    subscribed.tasks += 1;
    return {
      close() {
        subscribed.tasks -= 1;
      },
    };
  },
  disposeWorkspace: async () => {
    disposed.tasks += 1;
  },
};

const debug: WorkspaceDebugAPI = {
  getStatus: async (workspaceId) => ({ status: 'absent', workspaceId }),
  listBreakpoints: async (workspaceId) => ({ status: 'ready', workspaceId, breakpoints: [] }),
  setBreakpoints: async (request) => ({ status: 'ready', workspaceId: request.workspaceId, breakpoints: [] }),
  start: async (request) => ({ status: 'paused', workspaceId: request.workspaceId, sessionId: 'dbg-1', generation: 1 }),
  stop: async (request) => ({ status: 'stopped', workspaceId: request.workspaceId }),
  continue: async (request) => ({ status: 'running', workspaceId: request.workspaceId }),
  pause: async (request) => ({ status: 'paused', workspaceId: request.workspaceId }),
  stepOver: async (request) => ({ status: 'paused', workspaceId: request.workspaceId }),
  stepIn: async (request) => ({ status: 'paused', workspaceId: request.workspaceId }),
  stepOut: async (request) => ({ status: 'paused', workspaceId: request.workspaceId }),
  getThreads: async () => ({ status: 'absent' }),
  getStack: async () => ({ status: 'absent' }),
  getScopes: async () => ({ status: 'absent' }),
  getVariables: async () => ({ status: 'absent' }),
  evaluate: async () => ({ status: 'absent' }),
  listWatch: async (workspaceId) => ({ status: 'ready', workspaceId, expressions: [] }),
  addWatch: async (request) => ({ status: 'ready', workspaceId: request.workspaceId, expressions: [] }),
  removeWatch: async (request) => ({ status: 'ready', workspaceId: request.workspaceId, expressions: [] }),
  subscribe() {
    subscribed.debug += 1;
    return {
      close() {
        subscribed.debug -= 1;
      },
    };
  },
  disposeWorkspace: async () => {
    disposed.debug += 1;
  },
};

const tests: WorkspaceTestAPI = {
  discover: async (request) => ({ status: 'empty', workspaceId: request.workspaceId, tests: [] }),
  run: async (request) => ({ status: 'stopped', workspaceId: request.workspaceId }),
  cancel: async (request) => ({ status: 'stopped', workspaceId: request.workspaceId }),
  getStatus: async (workspaceId) => ({ status: 'absent', workspaceId }),
  subscribe(workspaceId, listener) {
    void workspaceId;
    subscribed.tests += 1;
    listener({
      kind: 'test',
      test: { id: 'fail.test.js', label: 'fails', resourceId: 'fail.test.js', status: 'failed', message: 'boom' },
    });
    return {
      close() {
        subscribed.tests -= 1;
      },
    };
  },
  disposeWorkspace: async () => {
    disposed.tests += 1;
  },
};

const subscribed = { tasks: 0, debug: 0, tests: 0 };
const disposed = { tasks: 0, debug: 0, tests: 0 };

afterEach(() => {
  resetRunDebugServices();
  subscribed.tasks = 0;
  subscribed.debug = 0;
  subscribed.tests = 0;
  disposed.tasks = 0;
  disposed.debug = 0;
  disposed.tests = 0;
});

describe('run debug session visibility', () => {
  test('hidden views do not keep event subscriptions', () => {
    bindRunDebugServices({ tasks, debug, tests });
    expect(getBoundRunDebugServices()).not.toBeNull();
    expect(subscribed.debug).toBe(0);
    acquireRunDebugView('ws-run');
    expect(isRunDebugViewActive('ws-run')).toBe(true);
    expect(subscribed.debug).toBe(1);
    expect(peekLastTestFailure('ws-run')?.message).toBe('boom');
    releaseRunDebugView('ws-run');
    expect(isRunDebugViewActive('ws-run')).toBe(false);
    expect(subscribed.debug).toBe(0);
    expect(subscribed.tests).toBe(0);
  });
});
