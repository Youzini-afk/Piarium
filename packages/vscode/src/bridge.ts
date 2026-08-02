import * as vscode from 'vscode';
import { handleStandardGitBridgeMessage } from './bridge-git-runtime';
import { handleGitConflictBridgeMessage } from './bridge-git-conflict-runtime';
import { handleFsBridgeMessage } from './bridge-fs-runtime';
import { handleNativeVSCodeBridgeMessage } from './bridge-vscode-runtime';
import {
  DEFAULT_GITHUB_CLIENT_ID,
  DEFAULT_GITHUB_SCOPES,
  activateGitHubAuth,
  clearGitHubAuth,
  exchangeDeviceCode,
  fetchMe,
  getGitHubAuthFilePath,
  readGitHubAuth,
  readGitHubAuthList,
  startDeviceFlow,
  writeGitHubAuth,
} from './githubAuth';
import {
  createPullRequest,
  getPullRequestStatus,
  markPullRequestReady,
  mergePullRequest,
  parseGitHubRemoteUrl,
  resolveRepoFromDirectory,
  updatePullRequest,
} from './githubPr';
import {
  getIssue,
  listIssueComments,
  listIssues,
} from './githubIssues';
import {
  getPullRequestContext,
  listPullRequests,
} from './githubPulls';
import { persistSettings, readSettings } from './bridge-settings-runtime';
import { execGit } from './bridge-git-process-runtime';
import {
  parseDroppedFileReference,
  readUriAsAttachment,
  resolveUserPath,
  listDirectoryEntries,
  normalizeFsPath,
  searchDirectory,
  resolveFileReadPath,
} from './bridge-fs-helpers-runtime';
// Reuse the web runtime's terminal auth helper so VS Code and web install the
// same gh hosts.yml and git credential helper behavior.
// @ts-expect-error The web package currently ships these helpers as JS modules.
import { configureGitHubGitAuthor, installTerminalGitHubAuth } from '../../web/server/lib/github/terminal-auth.js';

export interface BridgeRequest {
  id: string;
  type: string;
  payload?: unknown;
}

export interface BridgeResponse {
  id: string;
  type: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface BridgeContext {
  context?: vscode.ExtensionContext;
}
const GITHUB_API_BASE = 'https://api.github.com';

type JsonRecord = Record<string, unknown>;

const readString = (value: unknown): string => (typeof value === 'string' ? value : '');
const readNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

const requireVSCodeContext = (ctx: BridgeContext | undefined): vscode.ExtensionContext => {
  if (!ctx?.context) {
    throw new Error('VS Code extension context is unavailable');
  }
  return ctx.context;
};

const requireGitHubAuth = async (ctx: BridgeContext | undefined) => {
  const context = requireVSCodeContext(ctx);
  const auth = await readGitHubAuth(context);
  if (!auth?.accessToken) {
    throw new Error('GitHub is not connected');
  }
  return { context, auth };
};

const getCurrentGitBranch = async (directory: string): Promise<string> => {
  const result = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], directory);
  return result.exitCode === 0 ? result.stdout.trim() : '';
};

const githubJsonFetch = async <T>(url: string, accessToken: string): Promise<T> => {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'Piarium',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status})`);
  }

  return await response.json() as T;
};

const listGitHubRemotes = async (directory: string): Promise<Array<{ name: string; repo: { owner: string; repo: string; url: string } }>> => {
  const result = await execGit(['remote', '-v'], directory);
  if (result.exitCode !== 0) {
    return [];
  }

  const remotes: Array<{ name: string; repo: { owner: string; repo: string; url: string } }> = [];
  const seen = new Set<string>();
  for (const line of result.stdout.split('\n')) {
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match || match[3] !== 'fetch') continue;
    const repo = parseGitHubRemoteUrl(match[2]);
    if (!repo) continue;
    const key = `${match[1]}:${repo.owner}/${repo.repo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    remotes.push({ name: match[1], repo });
  }
  return remotes;
};

const getRepoUpstream = async (accessToken: string, directory: string) => {
  const repo = await resolveRepoFromDirectory(directory);
  if (!repo) {
    return { connected: true, isFork: false, upstream: null };
  }

  const metadata = await githubJsonFetch<{
    fork?: boolean;
    parent?: { name?: string; owner?: { login?: string }; html_url?: string; default_branch?: string };
  }>(`${GITHUB_API_BASE}/repos/${repo.owner}/${repo.repo}`, accessToken);

  const parentOwner = metadata.parent?.owner?.login;
  const parentRepo = metadata.parent?.name;
  if (!metadata.fork || !parentOwner || !parentRepo) {
    return { connected: true, isFork: false, upstream: null };
  }

  const defaultBranch = metadata.parent?.default_branch || 'main';
  let defaultBranchSha: string | null = null;
  try {
    const ref = await githubJsonFetch<{ object?: { sha?: string } }>(
      `${GITHUB_API_BASE}/repos/${parentOwner}/${parentRepo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
      accessToken,
    );
    defaultBranchSha = ref.object?.sha ?? null;
  } catch {
    defaultBranchSha = null;
  }

  let remoteName: string | null = null;
  const remotes = await listGitHubRemotes(directory);
  const upstreamRemote = remotes.find((remote) => remote.repo.owner === parentOwner && remote.repo.repo === parentRepo);
  remoteName = upstreamRemote?.name ?? null;

  return {
    connected: true,
    isFork: true,
    upstream: {
      owner: parentOwner,
      repo: parentRepo,
      url: metadata.parent?.html_url || `https://github.com/${parentOwner}/${parentRepo}`,
      defaultBranch,
      defaultBranchSha,
      remoteName,
    },
  };
};

const listRepoBranches = async (accessToken: string, owner: string, repo: string): Promise<string[]> => {
  const branches: string[] = [];
  let page = 1;
  while (true) {
    const pageBranches = await githubJsonFetch<Array<{ name?: string }>>(
      `${GITHUB_API_BASE}/repos/${owner}/${repo}/branches?per_page=100&page=${page}`,
      accessToken,
    );
    if (!Array.isArray(pageBranches) || pageBranches.length === 0) break;
    for (const branch of pageBranches) {
      if (typeof branch.name === 'string' && branch.name) {
        branches.push(branch.name);
      }
    }
    if (pageBranches.length < 100) break;
    page += 1;
  }
  return branches;
};

const normalizeGitHubAccount = (entry: {
  accountId?: string;
  user?: { login: string; id?: number; avatarUrl?: string };
  scope?: string;
  current?: boolean;
}) => {
  const login = entry.user?.login || entry.accountId || '';
  return {
    id: entry.accountId || login,
    user: {
      login,
      id: entry.user?.id,
      avatarUrl: entry.user?.avatarUrl,
    },
    scope: entry.scope,
    current: Boolean(entry.current),
  };
};

const buildGitHubAuthStatus = async (context: vscode.ExtensionContext) => {
  const accounts = (await readGitHubAuthList(context)).map(normalizeGitHubAccount);
  const current = accounts.find((account) => account.current) ?? accounts[0];
  return {
    connected: Boolean(current),
    user: current?.user ?? null,
    scope: current?.scope,
    accounts,
  };
};

const handleGitHubBridgeMessage = async (
  message: BridgeRequest,
  ctx?: BridgeContext,
): Promise<BridgeResponse | null> => {
  const { id, type, payload } = message;
  const data = (payload && typeof payload === 'object') ? payload as JsonRecord : {};

  switch (type) {
    case 'api:github/auth:status': {
      const context = requireVSCodeContext(ctx);
      return { id, type, success: true, data: await buildGitHubAuthStatus(context) };
    }
    case 'api:github/auth:start': {
      return { id, type, success: true, data: await startDeviceFlow(DEFAULT_GITHUB_CLIENT_ID, DEFAULT_GITHUB_SCOPES) };
    }
    case 'api:github/auth:complete': {
      const context = requireVSCodeContext(ctx);
      const deviceCode = readString(data.deviceCode);
      const tokenResult = await exchangeDeviceCode(DEFAULT_GITHUB_CLIENT_ID, deviceCode);
      if (!tokenResult.access_token) {
        return {
          id,
          type,
          success: true,
          data: {
            connected: false,
            status: readString(tokenResult.error) || undefined,
            error: readString(tokenResult.error_description) || readString(tokenResult.error) || undefined,
          },
        };
      }
      const user = await fetchMe(tokenResult.access_token);
      await writeGitHubAuth(context, {
        accessToken: tokenResult.access_token,
        scope: tokenResult.scope,
        tokenType: tokenResult.token_type,
        createdAt: Date.now(),
        user,
      });
      return { id, type, success: true, data: { connected: true, user, scope: tokenResult.scope } };
    }
    case 'api:github/auth:disconnect': {
      const context = requireVSCodeContext(ctx);
      const removed = await clearGitHubAuth(context);
      return { id, type, success: true, data: { removed } };
    }
    case 'api:github/auth:activate': {
      const context = requireVSCodeContext(ctx);
      const accountId = readString(data.accountId);
      if (accountId) {
        await activateGitHubAuth(context, accountId);
      }
      return { id, type, success: true, data: await buildGitHubAuthStatus(context) };
    }
    case 'api:github/auth:terminal': {
      const context = requireVSCodeContext(ctx);
      const auth = await readGitHubAuth(context);
      if (!auth?.accessToken) {
        throw new Error('GitHub not connected');
      }
      const result = installTerminalGitHubAuth({
        auth,
        authFilePath: getGitHubAuthFilePath(context),
        configureGit: data.configureGit !== false,
      });
      return {
        id,
        type,
        success: true,
        data: {
          success: true,
          ghConfigPath: result.ghConfigPath,
          helperPath: result.helperPath,
          gitCredentialHelperConfigured: Boolean(result.gitCredentialHelperConfigured),
          gitCredentialHelperError: result.gitCredentialHelperError || '',
        },
      };
    }
    case 'api:github/auth:git-author': {
      const context = requireVSCodeContext(ctx);
      const auth = await readGitHubAuth(context);
      if (!auth?.accessToken) {
        throw new Error('GitHub not connected');
      }
      const result = configureGitHubGitAuthor({ auth });
      return {
        id,
        type,
        success: true,
        data: {
          success: true,
          userName: result.userName,
          userEmail: result.userEmail,
        },
      };
    }
    case 'api:github/me': {
      const { auth } = await requireGitHubAuth(ctx);
      return { id, type, success: true, data: await fetchMe(auth.accessToken) };
    }
    case 'api:github/pr:status': {
      const { auth } = await requireGitHubAuth(ctx);
      const directory = readString(data.directory);
      const branch = readString(data.branch) || await getCurrentGitBranch(directory);
      return { id, type, success: true, data: await getPullRequestStatus(auth.accessToken, auth.user?.login ?? null, directory, branch) };
    }
    case 'api:github/pr:create': {
      const { auth } = await requireGitHubAuth(ctx);
      const directory = readString(data.directory);
      return { id, type, success: true, data: await createPullRequest(auth.accessToken, directory, data as Parameters<typeof createPullRequest>[2]) };
    }
    case 'api:github/pr:update': {
      const { auth } = await requireGitHubAuth(ctx);
      const directory = readString(data.directory);
      return { id, type, success: true, data: await updatePullRequest(auth.accessToken, directory, data as Parameters<typeof updatePullRequest>[2]) };
    }
    case 'api:github/pr:merge': {
      const { auth } = await requireGitHubAuth(ctx);
      const directory = readString(data.directory);
      return { id, type, success: true, data: await mergePullRequest(auth.accessToken, directory, data as Parameters<typeof mergePullRequest>[2]) };
    }
    case 'api:github/pr:ready': {
      const { auth } = await requireGitHubAuth(ctx);
      const directory = readString(data.directory);
      const number = readNumber(data.number);
      return { id, type, success: true, data: await markPullRequestReady(auth.accessToken, directory, number) };
    }
    case 'api:github/issues:list': {
      const { auth } = await requireGitHubAuth(ctx);
      return { id, type, success: true, data: await listIssues(auth.accessToken, readString(data.directory), readNumber(data.page) || 1, readString(data.query) || undefined) };
    }
    case 'api:github/issues:get': {
      const { auth } = await requireGitHubAuth(ctx);
      return { id, type, success: true, data: await getIssue(auth.accessToken, readString(data.directory), readNumber(data.number)) };
    }
    case 'api:github/issues:comments': {
      const { auth } = await requireGitHubAuth(ctx);
      return { id, type, success: true, data: await listIssueComments(auth.accessToken, readString(data.directory), readNumber(data.number)) };
    }
    case 'api:github/pulls:list': {
      const { auth } = await requireGitHubAuth(ctx);
      return { id, type, success: true, data: await listPullRequests(auth.accessToken, readString(data.directory), readNumber(data.page) || 1, readString(data.query) || undefined) };
    }
    case 'api:github/pulls:context': {
      const { auth } = await requireGitHubAuth(ctx);
      return {
        id,
        type,
        success: true,
        data: await getPullRequestContext(
          auth.accessToken,
          readString(data.directory),
          readNumber(data.number),
          Boolean(data.includeDiff),
          Boolean(data.includeCheckDetails),
        ),
      };
    }
    case 'api:github/repo:upstream': {
      const { auth } = await requireGitHubAuth(ctx);
      return { id, type, success: true, data: await getRepoUpstream(auth.accessToken, readString(data.directory)) };
    }
    case 'api:github/repo:branches': {
      const { auth } = await requireGitHubAuth(ctx);
      return { id, type, success: true, data: await listRepoBranches(auth.accessToken, readString(data.owner), readString(data.repo)) };
    }
    default:
      return null;
  }
};


export async function handleBridgeMessage(message: BridgeRequest, ctx?: BridgeContext): Promise<BridgeResponse> {
  const { id, type, payload } = message;

  try {
    const standardGitResponse = await handleStandardGitBridgeMessage({ id, type, payload });
    if (standardGitResponse) return standardGitResponse;
    const conflictResponse = await handleGitConflictBridgeMessage({ id, type, payload });
    if (conflictResponse) return conflictResponse;
    const fsResponse = await handleFsBridgeMessage(
      { id, type, payload },
      {
        resolveUserPath,
        listDirectoryEntries,
        normalizeFsPath,
        execGit,
        searchDirectory,
        resolveFileReadPath,
        parseDroppedFileReference,
        readUriAsAttachment,
      }
    );
    if (fsResponse) return fsResponse;

    if (type === 'api:settings:get') {
      return { id, type, success: true, data: readSettings(ctx) };
    }
    if (type === 'api:settings:save') {
      const changes = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {};
      return { id, type, success: true, data: await persistSettings(changes, ctx) };
    }

    const nativeResponse = await handleNativeVSCodeBridgeMessage({ id, type, payload }, ctx);
    if (nativeResponse) return nativeResponse;

    const githubResponse = await handleGitHubBridgeMessage({ id, type, payload }, ctx);
    if (githubResponse) return githubResponse;

    return { id, type, success: false, error: `Unknown message type: ${type}` };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { id, type, success: false, error: errorMessage };
  }
}
