import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

import { dict as enDict } from './en';
import { dict as zhDict } from './zh-CN';

const WORKSPACE_KEYS = [
  'workspace.sidebar.title',
  'workspace.sidebar.actions.chooseWorkspace',
  'workspace.sidebar.actions.terminal',
  'workspace.sidebar.actions.newFolder',
  'workspace.sidebar.actions.upload',
  'workspace.sidebar.actions.sort',
  'workspace.sidebar.actions.refresh',
  'workspace.sidebar.sort.nameAsc',
  'workspace.sidebar.sort.nameDesc',
  'workspace.sidebar.sort.modifiedDesc',
  'workspace.sidebar.sort.modifiedAsc',
  'workspace.sidebar.menu.openChat',
  'workspace.sidebar.menu.openFiles',
  'workspace.sidebar.menu.openFile',
  'workspace.sidebar.menu.git',
  'workspace.sidebar.menu.terminal',
  'workspace.sidebar.menu.newFolder',
  'workspace.sidebar.menu.newFile',
  'workspace.sidebar.menu.upload',
  'workspace.sidebar.menu.refreshGitStatus',
  'workspace.sidebar.menu.addToSession',
  'workspace.sidebar.menu.copyPath',
  'workspace.sidebar.menu.download',
  'workspace.sidebar.menu.rename',
  'workspace.sidebar.menu.moveToTrash',
  'workspace.sidebar.menu.permanentDelete',
  'workspace.sidebar.trash.title',
  'workspace.sidebar.trash.empty',
  'workspace.sidebar.state.empty',
  'workspace.sidebar.state.loading',
  'workspace.sidebar.dialog.create.folderTitle',
  'workspace.sidebar.dialog.create.fileTitle',
  'workspace.sidebar.dialog.create.folderDescription',
  'workspace.sidebar.dialog.create.fileDescription',
  'workspace.sidebar.dialog.create.namePlaceholder',
  'workspace.sidebar.dialog.create.invalidName',
  'workspace.sidebar.dialog.create.failed',
  'workspace.sidebar.dialog.create.cancel',
  'workspace.sidebar.dialog.create.confirm',
  'workspace.sidebar.dialog.rename.title',
  'workspace.sidebar.dialog.rename.description',
  'workspace.sidebar.dialog.rename.placeholder',
  'workspace.sidebar.dialog.rename.invalidName',
  'workspace.sidebar.dialog.rename.sameName',
  'workspace.sidebar.dialog.rename.cancel',
  'workspace.sidebar.dialog.rename.submit',
  'workspace.sidebar.confirm.permanentDelete',
  'workspace.sidebar.toast.addedToSession',
  'workspace.sidebar.toast.workspaceSelected',
  'workspace.sidebar.toast.workspaceSelectFailed',
  'workspace.sidebar.toast.downloadFailed',
  'workspace.sidebar.toast.permanentlyDeleted',
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
  'workspace.sidebar.menu.git',
  'workspace.git.title',
]);

describe('workspace sidebar messages', () => {
  test('has Chinese translations for workspace controls', () => {
    for (const key of WORKSPACE_KEYS) {
      expect(enDict[key]).toBeTruthy();
      expect(zhDict[key]).toBeTruthy();
      if (!SAME_IN_CHINESE.has(key)) {
        expect(zhDict[key]).not.toBe(enDict[key]);
      }
    }
  });

  test('workspace rows expose a native context menu handler', () => {
    const source = readFileSync(
      resolve(testDir, '../../../components/workspace/WorkspaceSidebarSection.tsx'),
      'utf8',
    );

    expect(source).toContain('onContextMenu');
  });

  test('workspace rename uses a localized dialog instead of a native prompt', () => {
    const source = readFileSync(
      resolve(testDir, '../../../components/workspace/WorkspaceSidebarSection.tsx'),
      'utf8',
    );

    expect(source).toContain("t('workspace.sidebar.dialog.rename.title')");
    expect(source).toContain("t('workspace.sidebar.dialog.rename.submit')");
    expect(source).not.toContain("window.prompt(t('workspace.sidebar.prompt.renameTo')");
  });

  test('workspace create uses a localized dialog instead of a native prompt', () => {
    const source = readFileSync(
      resolve(testDir, '../../../components/workspace/WorkspaceSidebarSection.tsx'),
      'utf8',
    );

    expect(source).toContain("t('workspace.sidebar.dialog.create.folderTitle')");
    expect(source).toContain("t('workspace.sidebar.dialog.create.confirm')");
    expect(source).not.toContain("window.prompt(t('workspace.sidebar.prompt.newFolderName')");
    expect(source).not.toContain("window.prompt(t('workspace.sidebar.prompt.newFileName')");
  });

  test('workspace sidebar exposes the hidden trash directory', () => {
    const source = readFileSync(
      resolve(testDir, '../../../components/workspace/WorkspaceSidebarSection.tsx'),
      'utf8',
    );

    expect(source).toContain('TRASH_PATH');
    expect(source).toContain("t('workspace.sidebar.trash.title')");
    expect(source).toContain("t('workspace.sidebar.menu.permanentDelete')");
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
