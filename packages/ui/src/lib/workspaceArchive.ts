const ARCHIVE_SUFFIXES = ['.tar.gz', '.tgz', '.tar', '.zip'] as const;

const normalizeWorkspacePath = (value = ''): string => (
  value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/g, '')
);

export type WorkspaceArchiveMode = 'preview' | 'new-folder' | 'merge';

export const isWorkspaceArchivePath = (path: string): boolean => {
  const lower = normalizeWorkspacePath(path).toLowerCase();
  return ARCHIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
};

export const getWorkspaceArchiveBaseName = (path: string): string => {
  const normalized = normalizeWorkspacePath(path);
  const name = normalized.split('/').pop() || 'archive';
  const lower = name.toLowerCase();
  const suffix = ARCHIVE_SUFFIXES.find((candidate) => lower.endsWith(candidate));
  if (!suffix) return name;
  return name.slice(0, -suffix.length) || 'archive';
};

export const getWorkspaceArchiveParentPath = (path: string): string => {
  const normalized = normalizeWorkspacePath(path);
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index) : '';
};

export const getDefaultArchiveDestination = (
  path: string,
  mode: WorkspaceArchiveMode = 'new-folder',
): string => {
  const parent = getWorkspaceArchiveParentPath(path);
  if (mode === 'merge') return parent;
  const base = getWorkspaceArchiveBaseName(path);
  return parent ? `${parent}/${base}` : base;
};

export const formatWorkspaceArchiveBytes = (bytes: number): string => {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let current = value / 1024;
  for (const unit of units) {
    if (current < 1024 || unit === units[units.length - 1]) {
      return `${current.toFixed(current >= 10 ? 0 : 1)} ${unit}`;
    }
    current /= 1024;
  }
  return `${value} B`;
};
