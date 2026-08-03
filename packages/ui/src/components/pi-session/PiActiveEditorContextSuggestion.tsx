import React from 'react';
import type { SessionSnapshot } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import {
  createPiEditorContextDraft,
  samePiEditorContextDraft,
} from '@/lib/pi-runtime/editorContext';
import { getRuntimeKey } from '@/lib/runtime-switch';
import {
  EMPTY_INLINE_COMMENT_DRAFTS,
  getInlineCommentDraftKey,
  useInlineCommentDraftStore,
} from '@/stores/useInlineCommentDraftStore';
import { usePiEditorContextStore } from '@/stores/usePiEditorContextStore';

export const PiActiveEditorContextSuggestion: React.FC<{ snapshot: SessionSnapshot }> = ({ snapshot }) => {
  const { t } = useI18n();
  const activeEditorFile = usePiEditorContextStore((state) => state.activeEditorFile);
  const addDraft = useInlineCommentDraftStore((state) => state.addDraft);
  const draftKey = getInlineCommentDraftKey(getRuntimeKey(), snapshot.cwd, snapshot.sessionId);
  const drafts = useInlineCommentDraftStore((state) => (
    draftKey ? state.drafts[draftKey] ?? EMPTY_INLINE_COMMENT_DRAFTS : EMPTY_INLINE_COMMENT_DRAFTS
  ));

  if (!activeEditorFile) return null;

  const target = { directory: snapshot.cwd, sessionKey: snapshot.sessionId };
  const selectionDraft = activeEditorFile.selection
    ? createPiEditorContextDraft(activeEditorFile, 'selection')
    : null;
  const fileDraft = createPiEditorContextDraft(activeEditorFile, 'file');
  const selectionAttached = selectionDraft !== null
    && drafts.some((draft) => samePiEditorContextDraft(draft, selectionDraft));
  const fileAttached = drafts.some((draft) => samePiEditorContextDraft(draft, fileDraft));
  const showSelection = selectionDraft !== null && !selectionAttached;
  const showFile = !showSelection && !fileAttached;

  if (!showSelection && !showFile) return null;

  const selection = activeEditorFile.selection;
  const range = selection
    ? selection.startLine === selection.endLine
      ? `${selection.startLine}`
      : `${selection.startLine}-${selection.endLine}`
    : '';
  const label = showSelection
    ? `${activeEditorFile.fileName}:${range}`
    : activeEditorFile.fileName;
  const actionLabel = showSelection
    ? t('chat.fileAttachment.activeEditor.pinSelection')
    : t('chat.fileAttachment.activeEditor.addFile', { name: activeEditorFile.fileName });

  return (
    <div className="mb-2 flex min-w-0 items-center">
      <button
        type="button"
        title={`${actionLabel} · ${activeEditorFile.relativePath}`}
        aria-label={actionLabel}
        onClick={() => addDraft(target, showSelection ? selectionDraft! : fileDraft)}
        className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-dashed border-[var(--syntax-punctuation)] bg-transparent px-2 py-1 typography-micro italic text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
      >
        <Icon name={showSelection ? 'pushpin-2' : 'add'} className="size-3.5 shrink-0" />
        <Icon name="file-code" className="size-3.5 shrink-0" />
        <span className="max-w-[min(22rem,65vw)] truncate">{label}</span>
      </button>
    </div>
  );
};
