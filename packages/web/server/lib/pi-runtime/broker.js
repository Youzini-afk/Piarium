import { PiRuntimeBroker, resolveBundledPiHostEntry } from '@piarium/runtime-broker';

export function createWebPiRuntimeBroker({
  agentDir,
  clientVersion,
  cwd,
  emit = () => {},
  hostEntry,
  nodePath,
  packageRoot,
  runtimeSource,
} = {}) {
  return new PiRuntimeBroker({
    ...(typeof agentDir === 'string' && agentDir.trim() ? { agentDir: agentDir.trim() } : {}),
    client: {
      clientName: 'piarium-web-server',
      clientVersion: typeof clientVersion === 'string' && clientVersion ? clientVersion : '0.1.0',
      mode: 'headless',
    },
    ...(typeof cwd === 'string' && cwd ? { cwd } : {}),
    emit,
    hostEntry: hostEntry || resolveBundledPiHostEntry(),
    ...(nodePath ? { nodePath } : {}),
    ...(packageRoot ? { packageRoot } : {}),
    ...(runtimeSource ? { runtimeSource } : {}),
  });
}
