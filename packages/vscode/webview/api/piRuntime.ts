import type { PiRuntimeSnapshot } from '@piarium/protocol';
import type { PiRuntimeManagementAPI } from '@piarium/ui/lib/api/types';
import { disconnectPiRuntime, getPiRuntimeConnection } from '@piarium/ui/lib/pi-runtime/client';

const snapshotFromError = (error: unknown): PiRuntimeSnapshot => ({
  installations: [],
  issue: error instanceof Error ? error.message : String(error),
  status: 'failed',
});

export const createVSCodePiRuntimeAPI = (): PiRuntimeManagementAPI => {
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
          status: 'ready',
        };
      } catch (error) {
        return snapshotFromError(error);
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
