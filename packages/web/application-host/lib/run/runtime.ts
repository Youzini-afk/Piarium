// @ts-nocheck
import { createWorkspaceTaskRunner } from './tasks.js';
import { createDebugSupervisor } from './debug-supervisor.js';
import { createTestSupervisor } from './test-supervisor.js';
import { PIARIUM_NODE_DAP_ADAPTER_PATH } from './servers.js';

export const createRunRuntime = ({
  documents,
  spawn,
  pathModule,
  env,
  isTrusted,
  execPath = process.execPath,
  registerBuiltins = true,
}) => {
  const tasks = createWorkspaceTaskRunner({
    documents,
    spawn,
    pathModule,
    env,
    isTrusted,
    execPath,
  });
  const debug = createDebugSupervisor({
    documents,
    spawn,
    pathModule,
    env,
    isTrusted,
  });
  const tests = createTestSupervisor({
    documents,
    spawn,
    pathModule,
    env,
    isTrusted,
    execPath,
  });
  if (registerBuiltins) {
    debug.registerAdapter({
      adapterId: 'piarium.node',
      command: execPath,
      args: [PIARIUM_NODE_DAP_ADAPTER_PATH],
      languageIds: ['javascript', 'javascriptreact', 'typescript'],
      source: 'builtin',
    });
    tests.registerProvider({
      providerId: 'piarium.node-test',
      kind: 'node-test',
      source: 'builtin',
    });
  }
  return {
    tasks,
    debug,
    tests,
    async dispose() {
      await Promise.all([
        tasks.dispose(),
        debug.dispose(),
        tests.dispose(),
      ]);
    },
  };
};
