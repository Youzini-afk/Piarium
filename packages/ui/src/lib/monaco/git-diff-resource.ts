export const repositoryPathForGitDiff = (
  resourceId: string,
  repositoryResourceId: string,
): string | null => {
  const root = repositoryResourceId.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const resource = resourceId.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!root) return resource;
  if (resource === root) return '';
  return resource.startsWith(`${root}/`) ? resource.slice(root.length + 1) : null;
};
