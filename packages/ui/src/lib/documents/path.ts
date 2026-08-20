import type { DocumentIdentity } from './types';

const normalize = (value: string): string => value.replace(/\\/g, '/');

const comparable = (value: string): string => {
  const normalized = normalize(value);
  return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
};

export const resourceIdFromWorkspacePath = (workspaceRoot: string, filePath: string): string | null => {
  const root = normalize(workspaceRoot).replace(/\/+$/, '');
  const file = normalize(filePath);
  const rootKey = comparable(root);
  const fileKey = comparable(file);
  if (fileKey === rootKey) return '';
  const prefix = `${rootKey}/`;
  if (!fileKey.startsWith(prefix)) return null;
  return file.slice(root.length).replace(/^\/+/, '');
};

export const workspacePathFromResourceId = (workspaceRoot: string, resourceId: string): string => {
  const root = normalize(workspaceRoot).replace(/\/+$/, '');
  const relative = normalize(resourceId).replace(/^\/+/, '');
  if (!relative) return root;
  return `${root}/${relative}`;
};

export const documentIdentityForPath = (
  workspaceId: string | undefined,
  workspaceRoot: string | undefined,
  filePath: string | undefined,
): DocumentIdentity | undefined => {
  if (!workspaceId || !workspaceRoot || !filePath) return undefined;
  const resourceId = resourceIdFromWorkspacePath(workspaceRoot, filePath);
  if (resourceId === null) return undefined;
  return { workspaceId, resourceId };
};

export const pickWorkspaceRoot = (
  filePath: string,
  roots: Array<string | null | undefined>,
): string | null => {
  for (const root of roots) {
    if (root && resourceIdFromWorkspacePath(root, filePath) !== null) return root;
  }
  return null;
};
