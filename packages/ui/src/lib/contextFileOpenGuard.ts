import type { DocumentsAPI } from '@/lib/api/types';
import { MAX_OPEN_FILE_LINES, countLinesWithLimit } from '@/lib/fileOpenLimits';
import { getCurrentIntlLocale } from '@/lib/i18n';
import { formatMessage, useI18nStore } from '@/lib/i18n/store';
import { isBinaryFile, isImageFile, isPdfFile, looksLikeBinaryText } from '@/lib/toolHelpers';
import { DocumentsError } from '@/lib/api/documents-errors';
import { readWorkspaceTextFile } from '@/lib/documents/workspace-text';

const t = (key: Parameters<typeof formatMessage>[1], params?: Parameters<typeof formatMessage>[2]) =>
  formatMessage(useI18nStore.getState().dictionary, key, params);

export type ContextFileOpenFailureReason = 'too-large' | 'missing' | 'unreadable' | 'binary';

export type ContextFileOpenValidationResult =
  | { ok: true }
  | { ok: false; reason: ContextFileOpenFailureReason };

export type ContextFileOpenOptions = {
  directory: string;
};

const classifyReadError = (error: unknown): ContextFileOpenFailureReason => {
  if (error instanceof DocumentsError && error.reason === 'path-escape') {
    return 'unreadable';
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();

  if (
    normalized.includes('file not found')
    || normalized.includes('not found')
    || normalized.includes('enoent')
    || normalized.includes('no such file')
    || normalized.includes('does not exist')
    || normalized.includes('missing')
  ) {
    return 'missing';
  }

  return 'unreadable';
};

/**
 * Validate whether a context-panel click may open a path in the shared file editor.
 * Previewable/non-text binaries are allowed through so FilesView can show image/PDF
 * preview or the cannot-preview empty state — never by decoding them as editable text here.
 */
export const validateContextFileOpen = async (
  documents: DocumentsAPI,
  path: string,
  options: ContextFileOpenOptions,
): Promise<ContextFileOpenValidationResult> => {
  if (isBinaryFile(path) || isPdfFile(path) || isImageFile(path)) {
    return { ok: true };
  }

  try {
    const content = await readWorkspaceTextFile(documents, options.directory, path);
    if (content === null) {
      return { ok: false, reason: 'missing' };
    }
    if (looksLikeBinaryText(content)) {
      return { ok: false, reason: 'binary' };
    }
    const lineCount = countLinesWithLimit(content, MAX_OPEN_FILE_LINES);
    if (lineCount > MAX_OPEN_FILE_LINES) {
      return { ok: false, reason: 'too-large' };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, reason: classifyReadError(error) };
  }
};

export const getContextFileOpenFailureMessage = (reason: ContextFileOpenFailureReason): string => {
  if (reason === 'too-large') {
    const lines = MAX_OPEN_FILE_LINES.toLocaleString(getCurrentIntlLocale());
    return t('contextFileOpen.failure.tooLarge', { count: lines });
  }

  if (reason === 'missing') {
    return t('contextFileOpen.failure.missing');
  }

  if (reason === 'binary') {
    return t('filesView.editor.cannotPreviewBinary');
  }

  return t('contextFileOpen.failure.unreadable');
};
