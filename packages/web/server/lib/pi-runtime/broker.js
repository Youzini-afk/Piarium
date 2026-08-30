import { PiRuntimeBroker, resolveBundledPiHostEntry } from '@piarium/runtime-broker';
import { FOUNDATIONAL_PI_PACKAGE_MANIFEST } from '@piarium/protocol';

export function attachPiSessionExecutionAdmission(broker, admitSessionExecution) {
  if (!broker || typeof broker.setSessionExecutionAdmission !== 'function') {
    throw new TypeError('Injected Pi runtime broker does not support session execution admission');
  }
  broker.setSessionExecutionAdmission(admitSessionExecution);
  return broker;
}

export function createWebPiRuntimeBroker({
  agentDir,
  admitSessionExecution,
  clientVersion,
  cwd,
  emit = () => {},
  foundationalPackages = FOUNDATIONAL_PI_PACKAGE_MANIFEST.integrations,
  hostEntry,
  nodePath,
  packageRoot,
  runtimeGeneration,
  runtimeSource,
} = {}) {
  return new PiRuntimeBroker({
    ...(typeof agentDir === 'string' && agentDir.trim() ? { agentDir: agentDir.trim() } : {}),
    ...(typeof admitSessionExecution === 'function' ? { admitSessionExecution } : {}),
    client: {
      capabilities: { workspaceMutationJournal: true },
      clientName: 'piarium-web-server',
      clientVersion: typeof clientVersion === 'string' && clientVersion ? clientVersion : '0.1.0',
      mode: 'headless',
    },
    ...(typeof cwd === 'string' && cwd ? { cwd } : {}),
    emit,
    foundationalPackages,
    hostEntry: hostEntry || resolveBundledPiHostEntry(),
    ...(nodePath ? { nodePath } : {}),
    ...(packageRoot ? { packageRoot } : {}),
    ...(Number.isSafeInteger(runtimeGeneration) && runtimeGeneration > 0 ? { runtimeGeneration } : {}),
    ...(runtimeSource ? { runtimeSource } : {}),
  });
}
