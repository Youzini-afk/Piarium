import type { RuntimeAPIs } from '@/lib/api/types';
import { normalizeFilePath } from '@/lib/path-utils';

const isFilesystemRoot = (value: string): boolean => (
  value === '/' || /^[A-Za-z]:\/$/.test(value)
);

export const resolveDefaultDirectory = (
  currentDirectory: string | null | undefined,
  workspaceRoot: string | null | undefined,
): string | null => {
  const current = normalizeFilePath(currentDirectory);
  const root = normalizeFilePath(workspaceRoot);

  if (current && !isFilesystemRoot(current)) return current;
  if (root && !isFilesystemRoot(root)) return root;
  return current || root || null;
};

export const resolveRestoredDirectory = (options: {
  latestPersistedDirectory?: string | null;
  persistedDirectory?: string | null;
  workspaceRoot?: string | null;
}): string | null => {
  const persisted = normalizeFilePath(options.persistedDirectory);
  const latestPersisted = normalizeFilePath(options.latestPersistedDirectory);
  const selectedDuringRestore = latestPersisted && latestPersisted !== persisted;
  return resolveDefaultDirectory(
    selectedDuringRestore ? latestPersisted : persisted,
    options.workspaceRoot,
  );
};

export const resolveRuntimeWorkspaceRoot = async (
  apis: RuntimeAPIs,
  options: { desktopLocal?: boolean } = {},
): Promise<string | null> => {
  if (options.desktopLocal || apis.runtime.isVSCode || !apis.workspace) return null;
  const snapshot = await apis.workspace.getRoot();
  return normalizeFilePath(snapshot.root) || null;
};
