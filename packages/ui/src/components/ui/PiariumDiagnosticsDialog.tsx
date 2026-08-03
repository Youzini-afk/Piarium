import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { buildPiariumDiagnosticsReport } from '@/lib/piariumDiagnostics';
import { useUIStore } from '@/stores/useUIStore';

export const PiariumDiagnosticsDialog: React.FC = () => {
  const { t } = useI18n();
  const open = useUIStore((state) => state.isPiariumDiagnosticsDialogOpen);
  const setOpen = useUIStore((state) => state.setPiariumDiagnosticsDialogOpen);
  const [report, setReport] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const generationRef = React.useRef(0);

  const collect = React.useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await buildPiariumDiagnosticsReport();
      if (generation !== generationRef.current) return;
      setReport(next);
    } catch (cause) {
      if (generation !== generationRef.current) return;
      setReport('');
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (!open) {
      generationRef.current += 1;
      setLoading(false);
      return;
    }
    void collect();
  }, [collect, open]);

  const handleCopy = React.useCallback(async () => {
    if (!report) return;
    const result = await copyTextToClipboard(report);
    if (result.ok) {
      toast.success(t('piariumDiagnosticsDialog.toast.copiedTitle'), {
        description: t('piariumDiagnosticsDialog.toast.copiedDescription'),
      });
      return;
    }
    toast.error(t('piariumDiagnosticsDialog.toast.copyFailed'));
  }, [report, t]);

  const displayText = loading
    ? t('piariumDiagnosticsDialog.state.collecting')
    : error
      ? t('piariumDiagnosticsDialog.state.failed', { error })
      : report || t('piariumDiagnosticsDialog.empty.noData');

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('piariumDiagnosticsDialog.title')}</DialogTitle>
          <DialogDescription>
            {t('piariumDiagnosticsDialog.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => void collect()}
            disabled={loading}
            className="app-region-no-drag inline-flex h-9 items-center justify-center rounded-md px-3 typography-ui-label font-medium text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('piariumDiagnosticsDialog.actions.refresh')}
          </button>
          <button
            type="button"
            onClick={() => void handleCopy()}
            disabled={loading || !report}
            className="app-region-no-drag inline-flex h-9 items-center justify-center rounded-md px-3 typography-ui-label font-medium text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('piariumDiagnosticsDialog.actions.copy')}
          </button>
        </div>

        <pre className="max-h-[65vh] overflow-auto rounded-lg bg-surface-muted p-4 typography-code text-foreground whitespace-pre-wrap">
          {displayText}
        </pre>
      </DialogContent>
    </Dialog>
  );
};
