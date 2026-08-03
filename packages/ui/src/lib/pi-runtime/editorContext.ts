import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import type { PiActiveEditorFile } from '@/stores/usePiEditorContextStore';

type PiEditorContextDraft = Omit<InlineCommentDraft, 'createdAt' | 'id' | 'sessionKey'>;

const codeFenceLanguage = (fileName: string): string => {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  return /^[a-z0-9_+#-]+$/.test(extension) ? extension : '';
};

export const createPiEditorContextDraft = (
  file: PiActiveEditorFile,
  kind: 'file' | 'selection',
): PiEditorContextDraft => {
  if (kind === 'selection' && file.selection) {
    return {
      code: file.selection.text,
      endLine: file.selection.endLine,
      fileLabel: file.relativePath,
      language: codeFenceLanguage(file.fileName),
      source: 'editor-selection',
      startLine: file.selection.startLine,
      text: '',
    };
  }
  return {
    code: file.filePath,
    endLine: 0,
    fileLabel: file.relativePath,
    language: '',
    source: 'editor-file',
    startLine: 0,
    text: '',
  };
};

export const samePiEditorContextDraft = (
  draft: InlineCommentDraft,
  candidate: PiEditorContextDraft,
): boolean => (
  draft.source === candidate.source
  && draft.fileLabel === candidate.fileLabel
  && draft.startLine === candidate.startLine
  && draft.endLine === candidate.endLine
  && draft.code === candidate.code
);
