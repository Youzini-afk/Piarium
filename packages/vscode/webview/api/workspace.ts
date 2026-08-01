import type { WorkspaceAPI } from '@openchamber/ui/lib/api/types';

const unsupported = async (): Promise<never> => {
  throw new Error('Workspace file management is not available in the VS Code runtime.');
};

export const createVSCodeWorkspaceAPI = (): WorkspaceAPI => ({
  getRoot: unsupported,
  list: unsupported,
  tree: unsupported,
  entry: unsupported,
  createFolder: unsupported,
  createFile: unsupported,
  move: unsupported,
  deleteEntry: unsupported,
  readFile: unsupported,
  writeFile: unsupported,
  upload: unsupported,
  download: unsupported,
  previewArchive: unsupported,
  extractArchive: unsupported,
  openProject: unsupported,
  gitStatus: unsupported,
  gitFetch: unsupported,
  gitClone: unsupported,
  gitPull: unsupported,
  gitPush: unsupported,
  gitCheckout: unsupported,
  gitCommit: unsupported,
  gitLog: unsupported,
  gitRemotes: unsupported,
});
