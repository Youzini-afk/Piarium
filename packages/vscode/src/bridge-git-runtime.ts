import * as vscode from 'vscode';
import * as gitService from './gitService';
import type { BridgeResponse } from './bridge';
import { runVSCodeProcessMutation, type VSCodeMutationAuthority } from './documents-runtime';

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

const requireDirectory = (id: string, type: string, directory?: string): BridgeResponse | null => {
  if (!directory) {
    return { id, type, success: false, error: 'Directory is required' };
  }
  return null;
};

const isValidCommitHash = (hash: string | undefined): hash is string => (
  typeof hash === 'string' && /^[0-9a-fA-F]{7,40}$/.test(hash)
);

type GitBridgeDeps = {
  documents?: VSCodeMutationAuthority;
};

const runGitMutation = <T>(
  message: BridgeMessageInput,
  deps: GitBridgeDeps,
  targetPaths: readonly string[],
  operation: () => PromiseLike<T> | T,
): Promise<T> => runVSCodeProcessMutation({
  workspace: vscode.workspace,
  documents: deps.documents,
  targetPaths,
  owner: { kind: 'vscode-git', id: message.id },
  operation,
  purpose: `vscode-git:${message.type}`,
});

export async function handleStandardGitBridgeMessage(
  message: BridgeMessageInput,
  deps: GitBridgeDeps = {},
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;

  switch (type) {
    case 'api:git/clone': {
      const { remoteUrl, destinationPath, gitIdentity } = (payload || {}) as {
        remoteUrl?: string;
        destinationPath?: string;
        gitIdentity?: {
          userName?: string;
          userEmail?: string;
          sshKey?: string | null;
          signCommits?: boolean;
          signingKey?: string | null;
        } | null;
      };
      if (typeof remoteUrl !== 'string' || remoteUrl.trim().length === 0) {
        return { id, type, success: false, error: 'Repository URL is required' };
      }
      if (typeof destinationPath !== 'string' || destinationPath.trim().length === 0) {
        return { id, type, success: false, error: 'Destination path is required' };
      }
      const result = await runGitMutation(
        message,
        deps,
        [destinationPath.trim()],
        () => gitService.cloneRepository({
          remoteUrl: remoteUrl.trim(),
          destinationPath: destinationPath.trim(),
          gitIdentity: gitIdentity && typeof gitIdentity === 'object' ? gitIdentity : null,
        }),
      );
      return { id, type, success: true, data: result };
    }

    case 'api:git/check': {
      const { directory } = (payload || {}) as { directory?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const isRepo = await gitService.checkIsGitRepository(directory!);
      return { id, type, success: true, data: isRepo };
    }

    case 'api:git/worktree-type': {
      const { directory } = (payload || {}) as { directory?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const isLinked = await gitService.isLinkedWorktree(directory!);
      return { id, type, success: true, data: isLinked };
    }

    case 'api:git/status': {
      const { directory, mode } = (payload || {}) as { directory?: string; mode?: 'light' };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const status = await gitService.getGitStatus(directory!, mode === 'light' ? { mode } : undefined);
      return { id, type, success: true, data: status };
    }

    case 'api:git/branches': {
      const { directory, method, name, startPoint, force } = (payload || {}) as {
        directory?: string;
        method?: string;
        name?: string;
        startPoint?: string;
        force?: boolean;
      };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;

      const normalizedMethod = typeof method === 'string' ? method.toUpperCase() : 'GET';

      if (normalizedMethod === 'GET') {
        const branches = await gitService.getGitBranches(directory!);
        return { id, type, success: true, data: branches };
      }

      if (normalizedMethod === 'POST') {
        if (!name) {
          return { id, type, success: false, error: 'Branch name is required' };
        }
        const result = await runGitMutation(message, deps, [directory!], () => gitService.createBranch(directory!, name, startPoint));
        return { id, type, success: true, data: result };
      }

      if (normalizedMethod === 'DELETE') {
        if (!name) {
          return { id, type, success: false, error: 'Branch name is required' };
        }
        const result = await runGitMutation(message, deps, [directory!], () => gitService.deleteGitBranch(directory!, name, force));
        return { id, type, success: true, data: result };
      }

      return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
    }

    case 'api:git/remote-branches': {
      const { directory, branch, remote } = (payload || {}) as {
        directory?: string;
        branch?: string;
        remote?: string;
      };
      if (!directory || !branch) {
        return { id, type, success: false, error: 'Directory and branch are required' };
      }
      const result = await runGitMutation(message, deps, [directory], () => gitService.deleteRemoteBranch(directory, branch, remote));
      return { id, type, success: true, data: result };
    }

    case 'api:git/checkout': {
      const { directory, branch } = (payload || {}) as { directory?: string; branch?: string };
      if (!directory || !branch) {
        return { id, type, success: false, error: 'Directory and branch are required' };
      }
      const result = await runGitMutation(message, deps, [directory], () => gitService.checkoutBranch(directory, branch));
      return { id, type, success: true, data: result };
    }

    case 'api:git/worktrees': {
      const { directory, method } = (payload || {}) as {
        directory?: string;
        method?: string;
        body?: unknown;
        directoryPath?: string;
        deleteLocalBranch?: boolean;
      };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;

      const normalizedMethod = typeof method === 'string' ? method.toUpperCase() : 'GET';

      if (normalizedMethod === 'GET') {
        const worktrees = await gitService.listGitWorktrees(directory!);
        return { id, type, success: true, data: worktrees };
      }

      if (normalizedMethod === 'POST') {
        // Worktree creation owns a lease that can outlive this bridge response.
        // Let the service acquire and hand off that single writer instead of
        // nesting it under a request-scoped writer that closes too early.
        const created = await gitService.createWorktree(
          directory!,
          (payload || {}) as gitService.CreateGitWorktreePayload,
          {
            documents: deps.documents,
            owner: { kind: 'vscode-git', id: `${message.id}:worktree-bootstrap` },
          },
        );
        return { id, type, success: true, data: created };
      }

      if (normalizedMethod === 'DELETE') {
        const removePayload = payload as {
          body?: { directory?: string; deleteLocalBranch?: boolean };
          directory?: string;
          deleteLocalBranch?: boolean;
        };
        const bodyDirectory = typeof removePayload?.body?.directory === 'string'
          ? removePayload.body.directory
          : '';
        const legacyDirectory = typeof removePayload?.directory === 'string' ? removePayload.directory : '';
        const worktreeDirectory = bodyDirectory || legacyDirectory || '';

        if (!worktreeDirectory) {
          return { id, type, success: false, error: 'Worktree directory is required' };
        }
        const removed = await runGitMutation(
          message,
          deps,
          [directory!, worktreeDirectory],
          () => gitService.removeWorktree(directory!, {
            directory: worktreeDirectory,
            deleteLocalBranch: removePayload?.body?.deleteLocalBranch === true || removePayload?.deleteLocalBranch === true,
          }),
        );
        return { id, type, success: true, data: { success: Boolean(removed) } };
      }

      return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
    }

    case 'api:git/worktrees/validate': {
      const { directory } = (payload || {}) as { directory?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await gitService.validateWorktreeCreate(directory!, (payload || {}) as gitService.CreateGitWorktreePayload);
      return { id, type, success: true, data: result };
    }

    case 'api:git/worktrees/bootstrap-status': {
      const { directory } = (payload || {}) as { directory?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await gitService.getWorktreeBootstrapStatus(directory!);
      return { id, type, success: true, data: result };
    }

    case 'api:git/worktrees/preview': {
      const { directory } = (payload || {}) as { directory?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await gitService.previewWorktreeCreate(directory!, (payload || {}) as gitService.CreateGitWorktreePayload);
      return { id, type, success: true, data: result };
    }

    case 'api:git/validate-directory': {
      const { directory, worktreeRoot } = (payload || {}) as { directory?: string; worktreeRoot?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await gitService.validateWorktreeDirectory(directory!, worktreeRoot!);
      return { id, type, success: true, data: result };
    }

    case 'api:git/canonicalize-worktree-state': {
      const { directory } = (payload || {}) as { directory?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await gitService.canonicalizeWorktreeState(directory!);
      return { id, type, success: true, data: result };
    }

    case 'api:git/diff': {
      const { directory, path: filePath, staged, contextLines } = (payload || {}) as {
        directory?: string;
        path?: string;
        staged?: boolean;
        contextLines?: number;
      };
      if (!directory || !filePath) {
        return { id, type, success: false, error: 'Directory and path are required' };
      }
      const result = await gitService.getGitDiff(directory, filePath, staged, contextLines);
      return { id, type, success: true, data: result };
    }

    case 'api:git/file-diff': {
      const { directory, path: filePath, staged } = (payload || {}) as {
        directory?: string;
        path?: string;
        staged?: boolean;
      };
      if (!directory || !filePath) {
        return { id, type, success: false, error: 'Directory and path are required' };
      }
      const result = await gitService.getGitFileDiff(directory, filePath, staged);
      return { id, type, success: true, data: result };
    }

    case 'api:git/revert': {
      const { directory, path: filePath, scope } = (payload || {}) as { directory?: string; path?: string; scope?: 'all' | 'working' };
      if (!directory || !filePath) {
        return { id, type, success: false, error: 'Directory and path are required' };
      }
      await runGitMutation(message, deps, [directory], () => gitService.revertGitFile(directory, filePath, { scope }));
      return { id, type, success: true, data: { success: true } };
    }

    case 'api:git/stage': {
      const { directory, path: filePath, paths } = (payload || {}) as { directory?: string; path?: string; paths?: string[] };
      const filePaths = (Array.isArray(paths) ? paths : [filePath])
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      if (!directory || filePaths.length === 0) {
        return { id, type, success: false, error: 'Directory and path are required' };
      }
      await runGitMutation(message, deps, [directory], () => gitService.stageGitFiles(directory, filePaths));
      return { id, type, success: true, data: { success: true } };
    }

    case 'api:git/unstage': {
      const { directory, path: filePath, paths } = (payload || {}) as { directory?: string; path?: string; paths?: string[] };
      const filePaths = (Array.isArray(paths) ? paths : [filePath])
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      if (!directory || filePaths.length === 0) {
        return { id, type, success: false, error: 'Directory and path are required' };
      }
      await runGitMutation(message, deps, [directory], () => gitService.unstageGitFiles(directory, filePaths));
      return { id, type, success: true, data: { success: true } };
    }

    case 'api:git/apply-hunk': {
      const { directory, path: filePath, patch, action } = (payload || {}) as {
        directory?: string;
        path?: string;
        patch?: string;
        action?: 'stage' | 'unstage' | 'discard';
      };
      if (!directory || !filePath || typeof patch !== 'string' || !patch.trim()) {
        return { id, type, success: false, error: 'Directory, path, and patch are required' };
      }
      if (action !== 'stage' && action !== 'unstage' && action !== 'discard') {
        return { id, type, success: false, error: 'action must be stage, unstage, or discard' };
      }
      await runGitMutation(message, deps, [directory], () => gitService.applyGitHunk(directory, filePath, patch, action));
      return { id, type, success: true, data: { success: true } };
    }

    case 'api:git/commit': {
      const { directory, message: commitMessage, addAll, files, stageFiles } = (payload || {}) as {
        directory?: string;
        message?: string;
        addAll?: boolean;
        files?: string[];
        stageFiles?: string[];
      };
      if (!directory || !commitMessage) {
        return { id, type, success: false, error: 'Directory and message are required' };
      }
      const result = await runGitMutation(
        message,
        deps,
        [directory],
        () => gitService.createGitCommit(directory, commitMessage, { addAll, files, stageFiles }),
      );
      return { id, type, success: true, data: result };
    }

    case 'api:git/push': {
      const { directory, remote, branch, options } = (payload || {}) as {
        directory?: string;
        remote?: string;
        branch?: string;
        options?: string[] | Record<string, unknown>;
      };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await runGitMutation(message, deps, [directory!], () => gitService.gitPush(directory!, { remote, branch, options }));
      return { id, type, success: true, data: result };
    }

    case 'api:git/pull': {
      const { directory, remote, branch, rebase } = (payload || {}) as {
        directory?: string;
        remote?: string;
        branch?: string;
        rebase?: boolean;
      };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await runGitMutation(message, deps, [directory!], () => gitService.gitPull(directory!, { remote, branch, rebase }));
      return { id, type, success: true, data: result };
    }

    case 'api:git/fetch': {
      const { directory, remote, branch } = (payload || {}) as {
        directory?: string;
        remote?: string;
        branch?: string;
      };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await runGitMutation(message, deps, [directory!], () => gitService.gitFetch(directory!, { remote, branch }));
      return { id, type, success: true, data: result };
    }

    case 'api:git/stashes': {
      const { directory } = (payload || {}) as { directory?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      return { id, type, success: true, data: { stashes: await gitService.listGitStashes(directory!) } };
    }

    case 'api:git/stashes/file-counts': {
      const { directory, refs } = (payload || {}) as { directory?: string; refs?: string[] };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      return { id, type, success: true, data: { counts: await gitService.countGitStashFiles(directory!, refs ?? []) } };
    }

    case 'api:git/stash': {
      const { directory, message: stashMessage } = (payload || {}) as { directory?: string; message?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      return {
        id,
        type,
        success: true,
        data: await runGitMutation(message, deps, [directory!], () => gitService.stashGitChanges(directory!, { message: stashMessage })),
      };
    }

    case 'api:git/stash/apply':
    case 'api:git/stash/pop':
    case 'api:git/stash/drop': {
      const { directory, ref } = (payload || {}) as { directory?: string; ref?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const stashRef = ref || 'stash@{0}';
      const data = await runGitMutation(message, deps, [directory!], () => type === 'api:git/stash/apply'
        ? gitService.applyGitStash(directory!, { ref: stashRef })
        : type === 'api:git/stash/pop'
          ? gitService.popGitStash(directory!, { ref: stashRef })
          : gitService.dropGitStash(directory!, { ref: stashRef }));
      return { id, type, success: true, data };
    }

    case 'api:git/remotes': {
      const { directory, method, remote } = (payload || {}) as {
        directory?: string;
        method?: string;
        remote?: string;
      };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;

      const normalizedMethod = typeof method === 'string' ? method.toUpperCase() : 'GET';
      if (normalizedMethod === 'GET') {
        const result = await gitService.getRemotes(directory!);
        return { id, type, success: true, data: result };
      }

      if (normalizedMethod === 'DELETE') {
        if (!remote) {
          return { id, type, success: false, error: 'Remote name is required' };
        }
        const result = await runGitMutation(message, deps, [directory!], () => gitService.removeRemote(directory!, remote));
        return { id, type, success: true, data: result };
      }

      return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
    }

    case 'api:git/rebase': {
      const { directory, onto } = (payload || {}) as { directory?: string; onto?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      if (!onto) {
        return { id, type, success: false, error: 'onto is required' };
      }
      const result = await runGitMutation(message, deps, [directory!], () => gitService.rebase(directory!, { onto }));
      return { id, type, success: true, data: result };
    }

    case 'api:git/rebase/abort': {
      const { directory } = (payload || {}) as { directory?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await runGitMutation(message, deps, [directory!], () => gitService.abortRebase(directory!));
      return { id, type, success: true, data: result };
    }

    case 'api:git/merge': {
      const { directory, branch } = (payload || {}) as { directory?: string; branch?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      if (!branch) {
        return { id, type, success: false, error: 'branch is required' };
      }
      const result = await runGitMutation(message, deps, [directory!], () => gitService.merge(directory!, { branch }));
      return { id, type, success: true, data: result };
    }

    case 'api:git/merge/abort': {
      const { directory } = (payload || {}) as { directory?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await runGitMutation(message, deps, [directory!], () => gitService.abortMerge(directory!));
      return { id, type, success: true, data: result };
    }

    case 'api:git/rebase/continue': {
      const { directory } = (payload || {}) as { directory?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await runGitMutation(message, deps, [directory!], () => gitService.continueRebase(directory!));
      return { id, type, success: true, data: result };
    }

    case 'api:git/merge/continue': {
      const { directory } = (payload || {}) as { directory?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await runGitMutation(message, deps, [directory!], () => gitService.continueMerge(directory!));
      return { id, type, success: true, data: result };
    }

    case 'api:git/checkout-commit': {
      const { directory, hash } = (payload || {}) as { directory?: string; hash?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      if (!isValidCommitHash(hash)) {
        return { id, type, success: false, error: 'Invalid commit hash' };
      }
      const result = await runGitMutation(message, deps, [directory!], () => gitService.checkoutCommit(directory!, hash));
      return { id, type, success: true, data: result };
    }

    case 'api:git/cherry-pick': {
      const { directory, hash } = (payload || {}) as { directory?: string; hash?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      if (!isValidCommitHash(hash)) {
        return { id, type, success: false, error: 'Invalid commit hash' };
      }
      const result = await runGitMutation(message, deps, [directory!], () => gitService.cherryPick(directory!, hash));
      return { id, type, success: true, data: result };
    }

    case 'api:git/revert-commit': {
      const { directory, hash } = (payload || {}) as { directory?: string; hash?: string };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      if (!isValidCommitHash(hash)) {
        return { id, type, success: false, error: 'Invalid commit hash' };
      }
      const result = await runGitMutation(message, deps, [directory!], () => gitService.revertCommit(directory!, hash));
      return { id, type, success: true, data: result };
    }

    case 'api:git/reset-to-commit': {
      const { directory, hash, mode, force } = (payload || {}) as {
        directory?: string;
        hash?: string;
        mode?: 'soft' | 'mixed' | 'hard';
        force?: boolean;
      };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      if (!isValidCommitHash(hash)) {
        return { id, type, success: false, error: 'Invalid commit hash' };
      }
      if (!mode || !['soft', 'mixed', 'hard'].includes(mode)) {
        return { id, type, success: false, error: 'mode must be soft, mixed, or hard' };
      }
      const result = await runGitMutation(message, deps, [directory!], () => gitService.resetToCommit(directory!, hash, mode, force));
      return { id, type, success: true, data: result };
    }

    case 'api:git/log': {
      const { directory, maxCount, from, to, file, all } = (payload || {}) as {
        directory?: string;
        maxCount?: number;
        from?: string;
        to?: string;
        file?: string;
        all?: boolean;
      };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;
      const result = await gitService.getGitLog(directory!, { maxCount, from, to, file, all });
      return { id, type, success: true, data: result };
    }

    case 'api:git/commit-files': {
      const { directory, hash } = (payload || {}) as { directory?: string; hash?: string };
      if (!directory || !hash) {
        return { id, type, success: false, error: 'Directory and hash are required' };
      }
      const result = await gitService.getCommitFiles(directory, hash);
      return { id, type, success: true, data: result };
    }

    case 'api:git/commit-file-diff': {
      const { directory, hash, path: filePath, binary } = (payload || {}) as {
        directory?: string;
        hash?: string;
        path?: string;
        binary?: boolean;
      };
      if (!directory || !hash || !filePath) {
        return { id, type, success: false, error: 'Directory, hash, and path are required' };
      }
      if (!/^[0-9a-fA-F]{7,40}$/.test(hash)) {
        return { id, type, success: false, error: 'hash must be a valid commit SHA' };
      }
      const result = await gitService.getCommitFileDiff(directory, hash, filePath, Boolean(binary));
      return { id, type, success: true, data: result };
    }

    case 'api:git/identity': {
      const { directory, method, userName, userEmail, sshKey, signCommits, signingKey } = (payload || {}) as {
        directory?: string;
        method?: string;
        userName?: string;
        userEmail?: string;
        sshKey?: string | null;
        signCommits?: boolean;
        signingKey?: string | null;
      };
      const dirError = requireDirectory(id, type, directory);
      if (dirError) return dirError;

      const normalizedMethod = typeof method === 'string' ? method.toUpperCase() : 'GET';

      if (normalizedMethod === 'GET') {
        const identity = await gitService.getCurrentGitIdentity(directory!);
        return { id, type, success: true, data: identity };
      }

      if (normalizedMethod === 'POST') {
        if (!userName || !userEmail) {
          return { id, type, success: false, error: 'userName and userEmail are required' };
        }
        const result = await runGitMutation(
          message,
          deps,
          [directory!],
          () => gitService.setGitIdentity(
            directory!,
            userName,
            userEmail,
            sshKey,
            signCommits === true,
            signingKey ?? null,
          ),
        );
        return { id, type, success: true, data: result };
      }

      return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
    }

    default:
      return null;
  }
}
