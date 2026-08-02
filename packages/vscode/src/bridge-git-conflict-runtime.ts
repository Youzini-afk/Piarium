import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BridgeRequest, BridgeResponse } from './bridge';
import { execGit } from './bridge-git-process-runtime';

export const handleGitConflictBridgeMessage = async (
  message: BridgeRequest,
): Promise<BridgeResponse | null> => {
  const { id, type, payload } = message;
  if (type !== 'api:git/conflict-details') return null;
  const directory = (payload as { directory?: string } | undefined)?.directory;
  if (!directory) return { id, type, success: false, error: 'Directory is required' };

  const [status, unmerged, diff, mergeHead, rebaseHead] = await Promise.all([
    execGit(['status', '--porcelain'], directory),
    execGit(['diff', '--name-only', '--diff-filter=U'], directory),
    execGit(['diff'], directory),
    execGit(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], directory),
    execGit(['rev-parse', '--verify', '--quiet', 'REBASE_HEAD'], directory),
  ]);
  const unmergedFiles = unmerged.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  let operation: 'merge' | 'rebase' = 'merge';
  let headInfo = '';
  if (mergeHead.exitCode === 0) {
    const gitDirectory = (await execGit(['rev-parse', '--git-dir'], directory)).stdout.trim();
    const mergeMessagePath = path.resolve(directory, gitDirectory || '.git', 'MERGE_MSG');
    const mergeMessage = await fs.promises.readFile(mergeMessagePath, 'utf8').catch(() => '');
    headInfo = `MERGE_HEAD: ${mergeHead.stdout.trim()}${mergeMessage ? `\n${mergeMessage}` : ''}`;
  } else if (rebaseHead.exitCode === 0) {
    operation = 'rebase';
    headInfo = `REBASE_HEAD: ${rebaseHead.stdout.trim()}`;
  }
  return {
    id,
    type,
    success: true,
    data: {
      statusPorcelain: status.stdout.trim(),
      unmergedFiles,
      diff: diff.stdout.trim(),
      headInfo: headInfo.trim(),
      operation,
    },
  };
};
