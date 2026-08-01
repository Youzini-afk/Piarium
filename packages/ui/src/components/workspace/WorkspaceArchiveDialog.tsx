import React from 'react';

import { RiFileZipLine } from '@remixicon/react';

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui';
import type {
  WorkspaceArchiveExtractRequest,
  WorkspaceArchivePreview,
} from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import {
  formatWorkspaceArchiveBytes,
  getDefaultArchiveDestination,
  type WorkspaceArchiveMode,
} from '@/lib/workspaceArchive';
import { cn } from '@/lib/utils';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';

type ExtractMode = WorkspaceArchiveExtractRequest['mode'];
type ConflictMode = WorkspaceArchiveExtractRequest['conflict'];

const normalizeDialogMode = (mode: WorkspaceArchiveMode): ExtractMode => (
  mode === 'merge' ? 'merge' : 'new-folder'
);

export const WorkspaceArchiveDialog: React.FC = () => {
  const { t } = useI18n();
  const dialog = useWorkspaceStore((state) => state.archiveDialog);
  const actionPending = useWorkspaceStore((state) => state.actionPending);
  const previewArchive = useWorkspaceStore((state) => state.previewArchive);
  const extractArchive = useWorkspaceStore((state) => state.extractArchive);
  const closeArchiveDialog = useWorkspaceStore((state) => state.closeArchiveDialog);
  const [preview, setPreview] = React.useState<WorkspaceArchivePreview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [mode, setMode] = React.useState<ExtractMode>('new-folder');
  const [destination, setDestination] = React.useState('');
  const [conflict, setConflict] = React.useState<ConflictMode>('rename');
  const [deleteArchive, setDeleteArchive] = React.useState(false);

  React.useEffect(() => {
    if (!dialog.open || !dialog.path) {
      setPreview(null);
      setError(null);
      setLoading(false);
      return;
    }

    const nextMode = normalizeDialogMode(dialog.mode);
    setMode(nextMode);
    setDestination(getDefaultArchiveDestination(dialog.path, nextMode));
    setConflict('rename');
    setDeleteArchive(false);

    let cancelled = false;
    setLoading(true);
    setError(null);
    void previewArchive(dialog.path).then((result) => {
      if (cancelled) return;
      setPreview(result);
      setLoading(false);
      if (!result) setError(t('workspace.archive.toast.previewFailed'));
    }).catch((previewError) => {
      if (cancelled) return;
      const message = previewError instanceof Error ? previewError.message : String(previewError);
      setError(message || t('workspace.archive.toast.previewFailed'));
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [dialog.mode, dialog.open, dialog.path, previewArchive, t]);

  React.useEffect(() => {
    if (!dialog.open || !dialog.path) return;
    setDestination(getDefaultArchiveDestination(dialog.path, mode));
  }, [dialog.open, dialog.path, mode]);

  const isExtracting = actionPending === `archive-extract:${dialog.path}`;
  const canExtract = Boolean(dialog.path && destination.trim() && !loading && !isExtracting);

  const handleExtract = React.useCallback(async () => {
    if (!dialog.path || !destination.trim()) return;
    const result = await extractArchive({
      path: dialog.path,
      destination: destination.trim(),
      mode,
      conflict,
      deleteArchive,
    });
    if (!result) return;
    toast.success(t('workspace.archive.toast.extracted', {
      files: result.filesCreated,
      folders: result.directoriesCreated,
    }));
    closeArchiveDialog();
  }, [closeArchiveDialog, conflict, deleteArchive, destination, dialog.path, extractArchive, mode, t]);

  return (
    <Dialog open={dialog.open} onOpenChange={(open) => {
      if (!open) closeArchiveDialog();
    }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <RiFileZipLine className="h-5 w-5 shrink-0 text-muted-foreground" />
            <span className="truncate">{t('workspace.archive.dialog.title')}</span>
          </DialogTitle>
          <DialogDescription>
            {dialog.path || t('workspace.archive.dialog.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 rounded-lg border border-border/60 p-3 sm:grid-cols-3">
            <div>
              <div className="typography-micro text-muted-foreground">{t('workspace.archive.dialog.format')}</div>
              <div className="typography-ui-label text-foreground">{preview?.format ?? '-'}</div>
            </div>
            <div>
              <div className="typography-micro text-muted-foreground">{t('workspace.archive.dialog.entries')}</div>
              <div className="typography-ui-label text-foreground">
                {preview ? t('workspace.archive.dialog.entryCount', {
                  files: preview.totalFiles,
                  folders: preview.totalDirectories,
                }) : '-'}
              </div>
            </div>
            <div>
              <div className="typography-micro text-muted-foreground">{t('workspace.archive.dialog.totalSize')}</div>
              <div className="typography-ui-label text-foreground">
                {preview ? formatWorkspaceArchiveBytes(preview.totalBytes) : '-'}
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5">
              <span className="typography-ui-label text-foreground">{t('workspace.archive.dialog.mode')}</span>
              <Select value={mode} onValueChange={(value) => setMode(value as ExtractMode)}>
                <SelectTrigger className="h-8 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="new-folder">{t('workspace.archive.mode.newFolder')}</SelectItem>
                  <SelectItem value="merge">{t('workspace.archive.mode.merge')}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="space-y-1.5">
              <span className="typography-ui-label text-foreground">{t('workspace.archive.dialog.conflict')}</span>
              <Select value={conflict} onValueChange={(value) => setConflict(value as ConflictMode)}>
                <SelectTrigger className="h-8 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="rename">{t('workspace.archive.conflict.rename')}</SelectItem>
                  <SelectItem value="skip">{t('workspace.archive.conflict.skip')}</SelectItem>
                  <SelectItem value="error">{t('workspace.archive.conflict.error')}</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>

          <label className="space-y-1.5">
            <span className="typography-ui-label text-foreground">{t('workspace.archive.dialog.destination')}</span>
            <Input
              value={destination}
              onChange={(event) => setDestination(event.currentTarget.value)}
              placeholder={t('workspace.archive.dialog.destinationPlaceholder')}
            />
          </label>

          <label className="flex items-center gap-2">
            <Checkbox
              checked={deleteArchive}
              onChange={setDeleteArchive}
              ariaLabel={t('workspace.archive.dialog.deleteArchive')}
            />
            <span className="typography-ui-label text-foreground">{t('workspace.archive.dialog.deleteArchive')}</span>
          </label>

          <div className="max-h-64 overflow-y-auto rounded-lg border border-border/60">
            {loading ? (
              <div className="p-3 typography-ui-label text-muted-foreground">
                {t('workspace.archive.dialog.loading')}
              </div>
            ) : error ? (
              <div className="p-3 typography-ui-label text-[var(--status-error)]">
                {error}
              </div>
            ) : preview && preview.entries.length > 0 ? (
              <div className="divide-y divide-border/50">
                {preview.entries.map((entry) => (
                  <div key={`${entry.type}:${entry.path}`} className="flex min-w-0 items-center gap-2 px-3 py-2">
                    <span className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      entry.type === 'directory' ? 'bg-[var(--status-info)]' : 'bg-muted-foreground',
                    )} />
                    <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">{entry.path}</span>
                    <span className="shrink-0 typography-micro text-muted-foreground">
                      {entry.type === 'file' ? formatWorkspaceArchiveBytes(entry.size) : t('workspace.archive.dialog.folder')}
                    </span>
                  </div>
                ))}
                {preview.truncated ? (
                  <div className="px-3 py-2 typography-micro text-muted-foreground">
                    {t('workspace.archive.dialog.truncated')}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="p-3 typography-ui-label text-muted-foreground">
                {t('workspace.archive.dialog.empty')}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={closeArchiveDialog} disabled={isExtracting}>
            {t('workspace.archive.actions.cancel')}
          </Button>
          <Button type="button" onClick={() => void handleExtract()} disabled={!canExtract}>
            {isExtracting ? t('workspace.archive.actions.extracting') : t('workspace.archive.actions.extract')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
