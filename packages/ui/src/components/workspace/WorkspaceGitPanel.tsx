import React from 'react';
import {
  RiArrowDownLine,
  RiArrowUpLine,
  RiGitBranchLine,
  RiGitCommitLine,
  RiGitRepositoryLine,
  RiRefreshLine,
  RiTerminalLine,
} from '@remixicon/react';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { GitRemote, GitStatusFile } from '@/lib/api/types';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';

const EMPTY_GIT_REMOTES: GitRemote[] = [];
const EMPTY_GIT_FILES: GitStatusFile[] = [];

export const WorkspaceGitPanel: React.FC = () => {
  const { t } = useI18n();
  const gitPanel = useWorkspaceStore((state) => state.gitPanel);
  const status = useWorkspaceStore((state) => state.gitStatusByPath[gitPanel.path]);
  const log = useWorkspaceStore((state) => state.gitLogByPath[gitPanel.path]);
  const remotes = useWorkspaceStore((state) => state.gitRemotesByPath[gitPanel.path] ?? EMPTY_GIT_REMOTES);
  const actionPending = useWorkspaceStore((state) => state.actionPending);
  const error = useWorkspaceStore((state) => state.error);
  const closeGitPanel = useWorkspaceStore((state) => state.closeGitPanel);
  const refreshGitStatus = useWorkspaceStore((state) => state.refreshGitStatus);
  const loadGitLog = useWorkspaceStore((state) => state.loadGitLog);
  const loadGitRemotes = useWorkspaceStore((state) => state.loadGitRemotes);
  const gitFetch = useWorkspaceStore((state) => state.gitFetch);
  const gitClone = useWorkspaceStore((state) => state.gitClone);
  const gitPull = useWorkspaceStore((state) => state.gitPull);
  const gitPush = useWorkspaceStore((state) => state.gitPush);
  const gitCheckout = useWorkspaceStore((state) => state.gitCheckout);
  const gitCommit = useWorkspaceStore((state) => state.gitCommit);
  const openTerminal = useWorkspaceStore((state) => state.openTerminal);

  const [cloneUrl, setCloneUrl] = React.useState('');
  const [cloneBranch, setCloneBranch] = React.useState('');
  const [cloneDirectory, setCloneDirectory] = React.useState('');
  const [commitMessage, setCommitMessage] = React.useState('');
  const [checkoutBranch, setCheckoutBranch] = React.useState('');
  const [stageAll, setStageAll] = React.useState(false);
  const [selectedFiles, setSelectedFiles] = React.useState<Record<string, boolean>>({});

  const files = React.useMemo(() => status?.files ?? EMPTY_GIT_FILES, [status?.files]);
  const isRepo = Boolean(status?.isGitRepository);
  const isBusy = Boolean(actionPending?.startsWith('git-'));

  React.useEffect(() => {
    if (!gitPanel.open) {
      return;
    }
    setCloneUrl('');
    setCloneBranch('');
    setCloneDirectory('');
    void (async () => {
      const nextStatus = await refreshGitStatus(gitPanel.path);
      if (nextStatus?.isGitRepository) {
        await Promise.all([
          loadGitLog(gitPanel.path, { maxCount: 8 }),
          loadGitRemotes(gitPanel.path),
        ]);
      }
    })();
  }, [gitPanel.open, gitPanel.path, loadGitLog, loadGitRemotes, refreshGitStatus]);

  React.useEffect(() => {
    setSelectedFiles((prev) => {
      const next: Record<string, boolean> = {};
      for (const file of files) {
        next[file.path] = prev[file.path] ?? false;
      }
      return next;
    });
  }, [files]);

  const refreshAll = React.useCallback(async () => {
    if (!gitPanel.open) return;
    const nextStatus = await refreshGitStatus(gitPanel.path);
    if (nextStatus?.isGitRepository) {
      await Promise.all([
        loadGitLog(gitPanel.path, { maxCount: 8 }),
        loadGitRemotes(gitPanel.path),
      ]);
    }
  }, [gitPanel.open, gitPanel.path, loadGitLog, loadGitRemotes, refreshGitStatus]);

  const handleFetch = React.useCallback(async () => {
    if (!gitPanel.open) return;
    if (await gitFetch(gitPanel.path)) {
      toast.success(t('workspace.git.toast.fetched'));
    }
  }, [gitFetch, gitPanel.open, gitPanel.path, t]);

  const handleClone = React.useCallback(async () => {
    const url = cloneUrl.trim();
    if (!gitPanel.open || !url) return;
    const result = await gitClone(gitPanel.path, {
      url,
      branch: cloneBranch.trim() || undefined,
      directoryName: cloneDirectory.trim() || undefined,
    });
    if (result) {
      toast.success(t('workspace.git.toast.cloned'));
      setCloneUrl('');
      setCloneBranch('');
      setCloneDirectory('');
      await refreshAll();
    }
  }, [cloneBranch, cloneDirectory, cloneUrl, gitClone, gitPanel.open, gitPanel.path, refreshAll, t]);

  const handlePull = React.useCallback(async () => {
    if (!gitPanel.open) return;
    const result = await gitPull(gitPanel.path);
    if (result) {
      toast.success(t('workspace.git.toast.pulled'));
      await refreshAll();
    }
  }, [gitPanel.open, gitPanel.path, gitPull, refreshAll, t]);

  const handlePush = React.useCallback(async () => {
    if (!gitPanel.open) return;
    const result = await gitPush(gitPanel.path);
    if (result) {
      toast.success(t('workspace.git.toast.pushed'));
      await refreshAll();
    }
  }, [gitPanel.open, gitPanel.path, gitPush, refreshAll, t]);

  const handleCheckout = React.useCallback(async () => {
    const branch = checkoutBranch.trim();
    if (!gitPanel.open || !branch) return;
    if (await gitCheckout(gitPanel.path, branch)) {
      toast.success(t('workspace.git.toast.checkedOut'));
      setCheckoutBranch('');
      await refreshAll();
    }
  }, [checkoutBranch, gitCheckout, gitPanel.open, gitPanel.path, refreshAll, t]);

  const handleCommit = React.useCallback(async () => {
    const message = commitMessage.trim();
    if (!gitPanel.open || !message) return;
    const filesToCommit = Object.entries(selectedFiles)
      .filter(([, selected]) => selected)
      .map(([file]) => file);
    if (!stageAll && filesToCommit.length === 0) {
      toast.error(t('workspace.git.toast.selectFiles'));
      return;
    }
    if (await gitCommit(gitPanel.path, message, {
      addAll: stageAll,
      files: stageAll ? undefined : filesToCommit,
    })) {
      toast.success(t('workspace.git.toast.committed'));
      setCommitMessage('');
      setStageAll(false);
      await refreshAll();
    }
  }, [commitMessage, gitCommit, gitPanel.open, gitPanel.path, refreshAll, selectedFiles, stageAll, t]);

  return (
    <Dialog open={gitPanel.open} onOpenChange={(open) => {
      if (!open) {
        closeGitPanel();
      }
    }}>
      <DialogContent className="h-[min(760px,calc(100vh-32px))] max-w-2xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/60 px-4 py-3">
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <RiGitBranchLine className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{t('workspace.git.title', { path: gitPanel.path || t('workspace.git.workspace') })}</span>
          </DialogTitle>
          <DialogDescription className="truncate">
            {status?.current || status?.tracking || t('workspace.git.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {error ? (
            <div className="mb-3 rounded-md border border-[var(--status-error)]/30 px-3 py-2 typography-ui-label text-[var(--status-error)]">
              {error}
            </div>
          ) : null}

          <div className="space-y-4">
            <section className="space-y-3 rounded-lg border border-border/60 px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="typography-ui-label font-medium text-foreground">{t('workspace.git.section.clone')}</div>
                  <div className="typography-micro text-muted-foreground">
                    {t('workspace.git.clone.description', { path: gitPanel.path || t('workspace.git.workspace') })}
                  </div>
                </div>
                <Button type="button" size="sm" variant="ghost" onClick={() => openTerminal(gitPanel.path)}>
                  <RiTerminalLine className="h-4 w-4" />
                  {t('workspace.git.actions.terminal')}
                </Button>
              </div>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_8rem_auto]">
                <Input
                  value={cloneUrl}
                  onChange={(event) => setCloneUrl(event.target.value)}
                  placeholder={t('workspace.git.placeholder.repositoryUrl')}
                  aria-label={t('workspace.git.placeholder.repositoryUrl')}
                  className="h-8"
                />
                <Input
                  value={cloneBranch}
                  onChange={(event) => setCloneBranch(event.target.value)}
                  placeholder={t('workspace.git.placeholder.cloneBranch')}
                  aria-label={t('workspace.git.placeholder.cloneBranch')}
                  className="h-8"
                />
                <Input
                  value={cloneDirectory}
                  onChange={(event) => setCloneDirectory(event.target.value)}
                  placeholder={t('workspace.git.placeholder.cloneDirectory')}
                  aria-label={t('workspace.git.placeholder.cloneDirectory')}
                  className="h-8"
                />
                <Button type="button" size="sm" onClick={handleClone} disabled={isBusy || !cloneUrl.trim()}>
                  <RiGitRepositoryLine className="h-4 w-4" />
                  {t('workspace.git.actions.clone')}
                </Button>
              </div>
            </section>

            {!status ? (
              <div className="rounded-lg border border-border/60 px-3 py-3 text-center typography-ui-label text-muted-foreground">
                {t('workspace.git.state.loading')}
              </div>
            ) : !isRepo ? (
              <div className="rounded-lg border border-border/60 px-3 py-3">
                <div className="flex items-center gap-2 typography-ui-label text-foreground">
                  <RiGitBranchLine className="h-4 w-4 text-muted-foreground" />
                  {t('workspace.git.state.notRepository')}
                </div>
                <div className="mt-1 typography-micro text-muted-foreground">
                  {t('workspace.git.state.notRepositoryHint')}
                </div>
              </div>
            ) : (
              <>
                <section className="space-y-3 rounded-lg border border-border/60 px-3 py-3">
                  <div className="typography-ui-label font-medium text-foreground">{t('workspace.git.section.repository')}</div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div className="rounded-md border border-border/60 px-3 py-2">
                      <div className="typography-micro text-muted-foreground">{t('workspace.git.summary.branch')}</div>
                      <div className="truncate typography-ui-label text-foreground">{status.current || '-'}</div>
                    </div>
                    <div className="rounded-md border border-border/60 px-3 py-2">
                      <div className="typography-micro text-muted-foreground">{t('workspace.git.summary.remote')}</div>
                      <div className="truncate typography-ui-label text-foreground">{status.tracking || '-'}</div>
                    </div>
                    <div className="rounded-md border border-border/60 px-3 py-2">
                      <div className="typography-micro text-muted-foreground">{t('workspace.git.summary.ahead')}</div>
                      <div className="typography-ui-label text-foreground">{status.ahead ?? 0}</div>
                    </div>
                    <div className="rounded-md border border-border/60 px-3 py-2">
                      <div className="typography-micro text-muted-foreground">{t('workspace.git.summary.behind')}</div>
                      <div className="typography-ui-label text-foreground">{status.behind ?? 0}</div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={refreshAll} disabled={isBusy}>
                      <RiRefreshLine className={cn('h-4 w-4', isBusy && 'animate-spin')} />
                      {t('workspace.git.actions.refresh')}
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={handleFetch} disabled={isBusy}>
                      <RiRefreshLine className="h-4 w-4" />
                      {t('workspace.git.actions.fetch')}
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={handlePull} disabled={isBusy}>
                      <RiArrowDownLine className="h-4 w-4" />
                      {t('workspace.git.actions.pull')}
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={handlePush} disabled={isBusy}>
                      <RiArrowUpLine className="h-4 w-4" />
                      {t('workspace.git.actions.push')}
                    </Button>
                  </div>
                </section>

                <section className="space-y-2 rounded-lg border border-border/60 px-3 py-3">
                  <div className="typography-ui-label font-medium text-foreground">{t('workspace.git.section.checkout')}</div>
                  <div className="flex gap-2">
                    <Input
                      value={checkoutBranch}
                      onChange={(event) => setCheckoutBranch(event.target.value)}
                      placeholder={t('workspace.git.placeholder.branch')}
                      className="h-8"
                    />
                    <Button type="button" size="sm" variant="outline" onClick={handleCheckout} disabled={isBusy || !checkoutBranch.trim()}>
                      {t('workspace.git.actions.checkout')}
                    </Button>
                  </div>
                </section>

                <section className="space-y-2 rounded-lg border border-border/60 px-3 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="typography-ui-label font-medium text-foreground">{t('workspace.git.section.changes')}</div>
                    <label className="flex items-center gap-2 typography-micro text-muted-foreground">
                      <Checkbox checked={stageAll} onChange={setStageAll} ariaLabel={t('workspace.git.actions.stageAll')} />
                      {t('workspace.git.actions.stageAll')}
                    </label>
                  </div>
                  {files.length === 0 ? (
                    <div className="rounded-md border border-border/60 px-3 py-3 typography-ui-label text-muted-foreground">
                      {t('workspace.git.state.clean')}
                    </div>
                  ) : (
                    <div className="max-h-48 overflow-y-auto rounded-md border border-border/60">
                      {files.map((file) => (
                        <label key={file.path} className="flex items-center gap-2 border-b border-border/40 px-3 py-2 last:border-b-0">
                          <Checkbox
                            checked={stageAll || Boolean(selectedFiles[file.path])}
                            onChange={(checked) => setSelectedFiles((prev) => ({ ...prev, [file.path]: checked }))}
                            disabled={stageAll}
                            ariaLabel={t('workspace.git.actions.selectFile', { path: file.path })}
                          />
                          <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">{file.path}</span>
                          <span className="shrink-0 typography-micro text-muted-foreground">{file.index || file.working_dir}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  <Textarea
                    value={commitMessage}
                    onChange={(event) => setCommitMessage(event.target.value)}
                    placeholder={t('workspace.git.placeholder.commitMessage')}
                    className="min-h-20"
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleCommit}
                    disabled={isBusy || !commitMessage.trim() || files.length === 0}
                  >
                    <RiGitCommitLine className="h-4 w-4" />
                    {t('workspace.git.actions.commit')}
                  </Button>
                </section>

                <div className="grid gap-3 sm:grid-cols-2">
                  <section className="space-y-2 rounded-lg border border-border/60 px-3 py-3">
                    <div className="typography-ui-label font-medium text-foreground">{t('workspace.git.section.remotes')}</div>
                    <div className="space-y-1">
                      {remotes.length === 0 ? (
                        <div className="typography-ui-label text-muted-foreground">{t('workspace.git.state.none')}</div>
                      ) : remotes.map((remote) => (
                        <div key={remote.name} className="rounded-md border border-border/60 px-3 py-2">
                          <div className="typography-ui-label text-foreground">{remote.name}</div>
                          <div className="truncate typography-micro text-muted-foreground">{remote.fetchUrl || remote.pushUrl}</div>
                        </div>
                      ))}
                    </div>
                  </section>
                  <section className="space-y-2 rounded-lg border border-border/60 px-3 py-3">
                    <div className="typography-ui-label font-medium text-foreground">{t('workspace.git.section.recentLog')}</div>
                    <div className="space-y-1">
                      {(log?.all ?? []).length === 0 ? (
                        <div className="typography-ui-label text-muted-foreground">{t('workspace.git.state.none')}</div>
                      ) : log?.all.map((entry) => (
                        <div key={entry.hash} className="rounded-md border border-border/60 px-3 py-2">
                          <div className="truncate typography-ui-label text-foreground">{entry.message}</div>
                          <div className="truncate typography-micro text-muted-foreground">{entry.hash.slice(0, 8)} · {entry.author_name}</div>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              </>
            )}
          </div>
        </div>

        <DialogFooter className="border-t border-border/60 px-4 py-3">
          <Button type="button" variant="outline" size="sm" onClick={closeGitPanel}>
            {t('workspace.git.actions.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
