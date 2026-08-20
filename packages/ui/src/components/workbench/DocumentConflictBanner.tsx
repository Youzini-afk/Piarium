import React from 'react';
import { Button } from '@/components/ui/button';
import { getDocumentRegistry } from '@/lib/documents/session';
import { useDocumentRecord } from '@/lib/documents/hooks';
import { useI18n } from '@/lib/i18n';
import { applyMergeDecisions, computeThreeWayMerge } from '@/lib/agent-editor/merge';
import type { DocumentIdentity } from '@/lib/documents/types';
import type { MergeRegionDecision } from '@/lib/agent-editor/types';

type DocumentConflictBannerProps = {
  identity: DocumentIdentity;
};

export const DocumentConflictBanner: React.FC<DocumentConflictBannerProps> = ({ identity }) => {
  const { t } = useI18n();
  const record = useDocumentRecord(identity);
  const [mergeOpen, setMergeOpen] = React.useState(false);
  const [edited, setEdited] = React.useState('');

  if (!record || (record.status !== 'conflict' && record.status !== 'deleted')) return null;

  const conflict = record.conflict;
  const regions = conflict
    ? computeThreeWayMerge(conflict.ancestorContent, record.buffer, conflict.diskContent)
    : [];
  const agent = record.externalSource === 'agent';

  const save = (): void => {
    void getDocumentRegistry().save(identity);
  };

  return (
    <div className="flex flex-col gap-2 border-b border-status-warning/30 bg-status-warning/10 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="typography-ui-label font-medium text-status-warning">
            {t(record.status === 'deleted' ? 'filesView.document.deleted.title' : 'filesView.document.conflict.title')}
          </div>
          <div className="typography-meta text-muted-foreground">
            {t(record.status === 'deleted'
              ? 'filesView.document.deleted.description'
              : agent
                ? 'filesView.document.conflict.agentDescription'
                : 'filesView.document.conflict.description')}
          </div>
        </div>
        {record.status === 'conflict' ? (
          <>
            <Button variant="outline" size="sm" onClick={() => getDocumentRegistry().discard(identity)}>
              {t('filesView.document.conflict.reloadDisk')}
            </Button>
            <Button variant="outline" size="sm" onClick={save}>
              {t('filesView.document.conflict.keepEdits')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setMergeOpen((value) => !value)}>
              {t('filesView.document.conflict.merge')}
            </Button>
          </>
        ) : (
          <Button variant="outline" size="sm" onClick={save}>
            {t('filesView.editor.saveFile')}
          </Button>
        )}
      </div>
      {mergeOpen && conflict ? (
        <div className="grid gap-2 md:grid-cols-3">
          <pre className="max-h-48 overflow-auto rounded-md border border-border/60 bg-background p-2 typography-micro whitespace-pre-wrap">
            <div className="mb-1 typography-meta text-muted-foreground">{t('filesView.document.conflict.ancestor')}</div>
            {conflict.ancestorContent}
          </pre>
          <pre className="max-h-48 overflow-auto rounded-md border border-border/60 bg-background p-2 typography-micro whitespace-pre-wrap">
            <div className="mb-1 typography-meta text-muted-foreground">{t('filesView.document.conflict.yours')}</div>
            {record.buffer}
          </pre>
          <pre className="max-h-48 overflow-auto rounded-md border border-border/60 bg-background p-2 typography-micro whitespace-pre-wrap">
            <div className="mb-1 typography-meta text-muted-foreground">{t('filesView.document.conflict.disk')}</div>
            {conflict.diskContent}
          </pre>
          {regions.map((region, index) => {
            if (region.kind !== 'conflict') return null;
            return (
              <div key={index} className="md:col-span-3 flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    const decisions: MergeRegionDecision[] = [{ index, choice: 'ours' }];
                    void getDocumentRegistry().applyMerged(identity, applyMergeDecisions(regions, decisions));
                  }}
                >
                  {t('filesView.document.conflict.acceptOurs')}
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    const decisions: MergeRegionDecision[] = [{ index, choice: 'theirs' }];
                    void getDocumentRegistry().applyMerged(identity, applyMergeDecisions(regions, decisions));
                  }}
                >
                  {t('filesView.document.conflict.acceptTheirs')}
                </Button>
                <textarea
                  className="min-h-20 w-full rounded-md border border-border/60 bg-background p-2 typography-micro"
                  value={edited || region.ours}
                  onChange={(event) => setEdited(event.target.value)}
                  aria-label={t('filesView.document.conflict.editHunk')}
                />
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    const decisions: MergeRegionDecision[] = [{ index, choice: 'edit', edited: edited || region.ours }];
                    void getDocumentRegistry().applyMerged(identity, applyMergeDecisions(regions, decisions));
                  }}
                >
                  {t('filesView.document.conflict.applyEdited')}
                </Button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};
