import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

import { dict as enDict } from './en';
import { dict as zhDict } from './zh-CN';

const WORKSPACE_KEYS = [
  'workspace.archive.menu.preview',
  'workspace.archive.menu.extractNewFolder',
  'workspace.archive.menu.extractHere',
  'workspace.archive.actions.extract',
  'workspace.archive.actions.extracting',
  'workspace.archive.actions.cancel',
  'workspace.archive.dialog.title',
  'workspace.archive.dialog.description',
  'workspace.archive.dialog.format',
  'workspace.archive.dialog.entries',
  'workspace.archive.dialog.entryCount',
  'workspace.archive.dialog.totalSize',
  'workspace.archive.dialog.mode',
  'workspace.archive.dialog.conflict',
  'workspace.archive.dialog.destination',
  'workspace.archive.dialog.destinationPlaceholder',
  'workspace.archive.dialog.deleteArchive',
  'workspace.archive.dialog.loading',
  'workspace.archive.dialog.folder',
  'workspace.archive.dialog.truncated',
  'workspace.archive.dialog.empty',
  'workspace.archive.mode.newFolder',
  'workspace.archive.mode.merge',
  'workspace.archive.conflict.rename',
  'workspace.archive.conflict.skip',
  'workspace.archive.conflict.error',
  'workspace.archive.toast.previewFailed',
  'workspace.archive.toast.extracted',
  'workspace.terminal.actions.restart',
  'workspace.terminal.actions.stop',
  'workspace.terminal.actions.restore',
  'workspace.terminal.actions.maximize',
  'workspace.terminal.actions.hide',
  'workspace.terminal.status.connecting',
  'workspace.terminal.status.processExited',
  'workspace.terminal.error.createFailed',
  'workspace.terminal.error.connectionFailed',
  'workspace.terminal.error.sendFailed',
  'workspace.git.title',
  'workspace.git.workspace',
  'workspace.git.description',
  'workspace.git.state.loading',
  'workspace.git.state.notRepository',
  'workspace.git.state.notRepositoryHint',
  'workspace.git.state.clean',
  'workspace.git.state.none',
  'workspace.git.actions.terminal',
  'workspace.git.actions.refresh',
  'workspace.git.actions.fetch',
  'workspace.git.actions.clone',
  'workspace.git.actions.pull',
  'workspace.git.actions.push',
  'workspace.git.actions.checkout',
  'workspace.git.actions.stageAll',
  'workspace.git.actions.selectFile',
  'workspace.git.actions.commit',
  'workspace.git.actions.close',
  'workspace.git.summary.branch',
  'workspace.git.summary.remote',
  'workspace.git.summary.ahead',
  'workspace.git.summary.behind',
  'workspace.git.section.clone',
  'workspace.git.section.repository',
  'workspace.git.section.checkout',
  'workspace.git.section.changes',
  'workspace.git.section.remotes',
  'workspace.git.section.recentLog',
  'workspace.git.clone.description',
  'workspace.git.placeholder.repositoryUrl',
  'workspace.git.placeholder.cloneBranch',
  'workspace.git.placeholder.cloneDirectory',
  'workspace.git.placeholder.branch',
  'workspace.git.placeholder.commitMessage',
  'workspace.git.toast.cloned',
  'workspace.git.toast.fetched',
  'workspace.git.toast.pulled',
  'workspace.git.toast.pushed',
  'workspace.git.toast.checkedOut',
  'workspace.git.toast.selectFiles',
  'workspace.git.toast.committed',
] as const;

const testDir = dirname(fileURLToPath(import.meta.url));
const SAME_IN_CHINESE = new Set<string>([
  'workspace.git.title',
]);

describe('workspace overlay messages', () => {
  test('has Chinese translations for workspace controls', () => {
    for (const key of WORKSPACE_KEYS) {
      expect(enDict[key]).toBeTruthy();
      expect(zhDict[key]).toBeTruthy();
      if (!SAME_IN_CHINESE.has(key)) {
        expect(zhDict[key]).not.toBe(enDict[key]);
      }
    }
  });

  test('workspace terminal and git overlays use localized messages', () => {
    const terminalSource = readFileSync(
      resolve(testDir, '../../../components/workspace/WorkspaceTerminalDialog.tsx'),
      'utf8',
    );
    const gitSource = readFileSync(
      resolve(testDir, '../../../components/workspace/WorkspaceGitPanel.tsx'),
      'utf8',
    );

    expect(terminalSource).toContain("t('workspace.terminal.actions.restart')");
    expect(gitSource).toContain("t('workspace.git.actions.refresh')");
  });

  test('workspace terminal stream does not reconnect on ordinary re-renders', () => {
    const source = readFileSync(
      resolve(testDir, '../../../components/workspace/WorkspaceTerminalDialog.tsx'),
      'utf8',
    );

    expect(source).toContain('activeTerminalIdRef.current === sessionId');
    expect(source).toContain('startStream(dialog.directoryKey, activeTabId, terminalSessionId)');
    expect(source).not.toContain('cleanupRef.current?.();');
  });
});
