import { isPathWithinRoot } from '../workspace/path-safety.js';

export interface DocumentRootGuardOptions {
  fsPromises: Pick<typeof import('node:fs/promises'), 'realpath'>;
  pathModule: typeof import('node:path');
  readSettings: () => Promise<Record<string, unknown>>;
  getWorkspaceRoot?: () => string | undefined | null;
  platform?: NodeJS.Platform;
}

export type DocumentRootGuard = (canonicalPath: string) => Promise<boolean>;

export const createDocumentRootGuard = ({
  fsPromises,
  pathModule,
  readSettings,
  getWorkspaceRoot,
  platform = process.platform,
}: DocumentRootGuardOptions): DocumentRootGuard => async (canonicalPath) => {
  const settings = await readSettings().catch(() => ({}));
  const roots: string[] = [];
  const projects = (settings as { projects?: unknown }).projects;
  if (Array.isArray(projects)) {
    for (const project of projects) {
      if (project && typeof project === 'object' && typeof (project as { path?: unknown }).path === 'string' && (project as { path: string }).path.trim()) {
        roots.push((project as { path: string }).path);
      }
    }
  }
  const lastDirectory = (settings as { lastDirectory?: unknown }).lastDirectory;
  if (typeof lastDirectory === 'string' && lastDirectory.trim()) {
    roots.push(lastDirectory);
  }
  const homeDirectory = (settings as { homeDirectory?: unknown }).homeDirectory;
  if (typeof homeDirectory === 'string' && homeDirectory.trim()) {
    roots.push(homeDirectory);
  }
  const workspaceRoot = getWorkspaceRoot?.();
  if (typeof workspaceRoot === 'string' && workspaceRoot.trim()) roots.push(workspaceRoot);
  for (const root of roots) {
    try {
      const real = await fsPromises.realpath(root);
      if (isPathWithinRoot(canonicalPath, real, pathModule, { platform })) return true;
    } catch {
      // A missing configured root is not itself a grant.
    }
  }
  return false;
};
