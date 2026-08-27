import { PiRuntimeBroker, resolveBundledPiHostEntry } from '@piarium/runtime-broker';
import { FOUNDATIONAL_PI_PACKAGE_MANIFEST } from '@piarium/protocol';

export function createWebPiRuntimeBroker({
  agentDir,
  clientVersion,
  cwd,
  emit = () => {},
  foundationalPackages = FOUNDATIONAL_PI_PACKAGE_MANIFEST.integrations,
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
    foundationalPackages,
    hostEntry: hostEntry || resolveBundledPiHostEntry(),
    ...(nodePath ? { nodePath } : {}),
    ...(packageRoot ? { packageRoot } : {}),
    ...(runtimeSource ? { runtimeSource } : {}),
  });
}
