import type { PiRuntimeSnapshot } from '@piarium/protocol';
import type { PiRuntimeManagementAPI } from '@piarium/application-client';
import { disconnectPiRuntime, getPiRuntimeConnection } from '@piarium/ui/lib/pi-runtime/client';

const snapshotFromError = (error: unknown, revision: number): PiRuntimeSnapshot => ({
  installations: [],
  issue: error instanceof Error ? error.message : String(error),
  revision,
  status: 'failed',
});

export const createVSCodePiRuntimeAPI = (): PiRuntimeManagementAPI => {
  let revision = 0;
  const nextRevision = () => {
    revision += 1;
    return revision;
  };
  const unsupported = async (): Promise<PiRuntimeSnapshot> => {
    throw new Error('Installing or changing the global Pi runtime is not available in VS Code');
  };
  return {
    capabilities: {
      install: false,
      openLocation: false,
      pickPackageRoot: false,
    },
    async getSnapshot() {
      try {
        const connection = await getPiRuntimeConnection();
        const runtime = connection.handshake.runtime;
        const active = {
          id: runtime.source === 'source' ? 'development' : runtime.source,
          source: runtime.source === 'source' ? 'development' : runtime.source,
          state: 'ready' as const,
          version: runtime.piVersion,
          nodePath: runtime.nodePath,
          ...(runtime.packageRoot === undefined ? {} : { packageRoot: runtime.packageRoot }),
        };
        return {
          active,
          installations: [active],
          revision: nextRevision(),
          status: 'ready',
        };
      } catch (error) {
        return snapshotFromError(error, nextRevision());
      }
    },
    subscribe() {
      return () => {};
    },
    async refresh() {
      await disconnectPiRuntime();
      return this.getSnapshot();
    },
    install: unsupported,
    upgrade: unsupported,
    activate: unsupported,
    activateCustom: unsupported,
    async pickPackageRoot() {
      return null;
    },
    async openLocation() {},
  };
};
