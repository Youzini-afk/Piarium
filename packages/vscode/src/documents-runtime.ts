import path from 'node:path';
// @ts-expect-error Application-host document authority is a JS module shared with Web.
import { createDocumentAuthority } from '../../web/server/lib/documents/authority.js';
// @ts-expect-error Host capability adapter is a JS module shared with Web.
import { createDocumentsCapabilityHandler } from '../../web/server/lib/documents/capability.js';

type VSCodeWorkspaceLike = {
  isTrusted: boolean;
  workspaceFolders?: readonly { uri: { fsPath: string } }[] | undefined;
};

export const createVSCodeDocumentAuthority = (options: {
  hostId: string;
  dataDir: string;
  workspace: VSCodeWorkspaceLike;
}) => createDocumentAuthority({
  hostId: options.hostId,
  dataDir: options.dataDir,
  isTrusted: async () => options.workspace.isTrusted !== false,
  isAllowedRoot: async (canonicalPath: string) => {
    const folders = options.workspace.workspaceFolders ?? [];
    const normalized = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
    return folders.some((folder) => {
      const root = process.platform === 'win32' ? folder.uri.fsPath.toLowerCase() : folder.uri.fsPath;
      return normalized === root || normalized.startsWith(`${root}${path.sep}`);
    });
  },
});

export { createDocumentsCapabilityHandler };
