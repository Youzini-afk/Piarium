export interface GitHubUser {
  avatarUrl?: string | null;
  email?: string | null;
  id?: number | string | null;
  login?: string | null;
  name?: string | null;
}

export interface GitHubAuthEntry {
  accessToken: string;
  accountId: string;
  createdAt: number | null;
  current: boolean;
  scope: string;
  tokenType: string;
  user: GitHubUser | null;
}

export interface SetGitHubAuthInput {
  accessToken: string;
  accountId?: string;
  scope?: string;
  tokenType?: string;
  user?: GitHubUser | null;
}

export interface GitHubRepoRef {
  owner: string;
  repo: string;
  url: string;
}

export interface SpawnSyncResult {
  error?: Error | null;
  status: number | null;
  stderr?: Buffer | string | null;
}

export type SpawnSync = (
  command: string,
  args: string[],
  options: { encoding: 'utf8' },
) => SpawnSyncResult;

export interface TerminalAuthOptions {
  auth?: GitHubAuthEntry | { accessToken?: string; user?: GitHubUser | null } | null;
  authFilePath?: string;
  configureGit?: boolean;
  homeDir?: string;
  spawnSync?: SpawnSync;
}
