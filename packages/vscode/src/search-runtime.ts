import path from 'node:path';
import type { DocumentAuthority } from '../../web/server/lib/documents/authority.js';
import { createKernelClient } from '../../web/server/lib/kernel/kernel-client.js';
import { createKernelComputeService } from '../../web/server/lib/kernel/compute-service.js';
import { createWorkspaceContentSearch } from '../../web/server/lib/search/content.js';

/** The companion reuses the Host compute implementation and owns its lifetime.
 * No source loader, Cargo runner or local ripgrep fallback is used in a VSIX. */
export function createVSCodeWorkspaceSearch(options: {
  extensionPath: string;
  dataDir: string;
  hostId: string;
  version: string;
  documents: Pick<DocumentAuthority, 'inspectWorkspace' | 'resolveWorkspace'>;
}) {
  const client = createKernelClient({
    hostId: options.hostId,
    storageRoot: path.join(options.dataDir, 'kernel', options.hostId),
    kernelPath: path.join(options.extensionPath, 'dist', 'kernel', process.platform === 'win32' ? 'piarium-kernel.exe' : 'piarium-kernel'),
    buildVersion: options.version,
    requireKernelManifest: true,
    allowCargoDevRunner: false,
  });
  const compute = createKernelComputeService({
    client,
    resolveIdentity: async (cwd) => {
      const { workspaceId } = await options.documents.resolveWorkspace({ path: cwd });
      const { root } = await options.documents.inspectWorkspace(workspaceId);
      return { workspaceId, executionWorkspaceId: workspaceId, canonicalRoot: root };
    },
  });
  const search = createWorkspaceContentSearch({ documents: options.documents, compute });
  let started: ReturnType<typeof client.start> | undefined;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  return {
    async searchContent(...args: Parameters<typeof search.searchContent>) {
      if (disposed) throw new Error('VS Code search authority is disposed');
      // Startup failure remains explicit; do not silently switch execution paths.
      await (started ??= client.start());
      if (disposed) throw new Error('VS Code search authority is disposed');
      return search.searchContent(...args);
    },
    dispose(): Promise<void> {
      disposed = true;
      return disposal ??= (async () => {
        if (started) await Promise.allSettled([started]);
        try { await compute.dispose(); } finally { await client.close(); }
      })();
    },
  };
}
