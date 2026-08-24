import {
  resourceIdFromWorkspacePath,
  workspacePathFromResourceId,
} from '@/lib/documents/path';

const normalizeDirectory = (value: string): string => {
  const normalized = value.trim().replace(/\\/g, '/');
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, '');
};

const normalizeGitPath = (value: string): string | null => {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return null;
  if (normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  return normalized;
};

export const gitRepositoryRootWithinWorkspace = (
  workspaceRoot: string,
  repositoryRoot: string,
): string | null => {
  const normalizedWorkspace = normalizeDirectory(workspaceRoot);
  const normalizedRepository = normalizeDirectory(repositoryRoot);
  if (!normalizedWorkspace || !normalizedRepository) return null;
  return resourceIdFromWorkspacePath(normalizedWorkspace, normalizedRepository) === null
    ? null
    : normalizedRepository;
};

export const resolveIdeGitResourceId = (
  workspaceRoot: string,
  repositoryRoot: string,
  gitPath: string,
): string | null => {
  const normalizedGitPath = normalizeGitPath(gitPath);
  const containedRepository = gitRepositoryRootWithinWorkspace(workspaceRoot, repositoryRoot);
  if (!normalizedGitPath || !containedRepository) return null;
  return resourceIdFromWorkspacePath(
    workspaceRoot,
    workspacePathFromResourceId(containedRepository, normalizedGitPath),
  );
};
