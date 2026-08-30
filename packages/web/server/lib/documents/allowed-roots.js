import { isPathWithinRoot } from '../workspace/path-safety.js';

export const createDocumentRootGuard = ({
  fsPromises,
  pathModule,
  readSettings,
  getWorkspaceRoot,
  platform = process.platform,
}) => async (canonicalPath) => {
  const settings = await readSettings().catch(() => ({}));
  const roots = [];
  if (Array.isArray(settings?.projects)) {
    for (const project of settings.projects) {
      if (project && typeof project.path === 'string' && project.path.trim()) roots.push(project.path);
    }
  }
  if (typeof settings?.lastDirectory === 'string' && settings.lastDirectory.trim()) {
    roots.push(settings.lastDirectory);
  }
  if (typeof settings?.homeDirectory === 'string' && settings.homeDirectory.trim()) {
    roots.push(settings.homeDirectory);
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
