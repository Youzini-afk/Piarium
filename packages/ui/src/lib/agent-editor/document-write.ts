import { getDocumentRegistry } from '@/lib/documents/session';
import { detectLineEnding, normalizeEditorLineEndings, serializeEditorContent } from '@/lib/documents/line-ending';
import type { DocumentIdentity } from '@/lib/documents/types';
import type { DocumentsAPI } from '@/lib/api/types';
import { applyHunkDecisions, parseUnifiedHunks } from './patch';
import type { DocumentPatchWriteResult, HunkDecision } from './types';

const revisionFromConflictCurrent = (current: { revision?: string }): string | null => (
  typeof current.revision === 'string' ? current.revision : null
);

const writeDocumentIfClean = async (
  documents: DocumentsAPI,
  identity: DocumentIdentity,
  content: string,
  expectedRevision: string | null,
): Promise<DocumentPatchWriteResult> => {
  const registry = getDocumentRegistry();
  const open = registry.get(identity);
  if (open?.dirty) {
    return { status: 'conflict', currentRevision: open.baseRevision, dirty: true };
  }
  try {
    const result = await documents.write({
      resource: identity,
      content,
      encoding: open?.encoding ?? 'utf-8',
      bom: open?.bom ?? false,
      expectedRevision,
      operationId: crypto.randomUUID(),
    });
    if (result.status === 'conflict') {
      return {
        status: 'conflict',
        currentRevision: revisionFromConflictCurrent(result.current as { revision?: string }),
        dirty: false,
      };
    }
    if (open) await registry.reload(identity);
    return { status: 'written', revision: result.revision };
  } catch (error) {
    return { status: 'failure', errorMessage: error instanceof Error ? error.message : String(error) };
  }
};

export const applyPatchDecisionsToDocument = async (input: {
  documents: DocumentsAPI;
  identity: DocumentIdentity;
  patch: string;
  decisions: readonly HunkDecision[];
  direction: 'apply' | 'revert';
}): Promise<DocumentPatchWriteResult> => {
  const registry = getDocumentRegistry();
  const open = registry.get(input.identity);
  if (open?.dirty) {
    return { status: 'conflict', currentRevision: open.baseRevision, dirty: true };
  }
  const read = open
    ? {
      status: 'ready' as const,
      content: open.baseContent,
      revision: open.baseRevision,
      lineEnding: open.lineEnding,
    }
    : await input.documents.read(input.identity).then((result) => (
      result.status === 'ready'
        ? {
          status: 'ready' as const,
          content: result.content,
          revision: result.revision,
          lineEnding: detectLineEnding(result.content),
        }
        : result
    ));
  if (read.status === 'missing') return { status: 'missing' };
  if (read.status !== 'ready') {
    return { status: 'failure', errorMessage: read.status };
  }
  const hunks = parseUnifiedHunks(input.patch);
  if (hunks.length === 0) {
    return { status: 'failure', errorMessage: 'empty-patch' };
  }
  const applied = applyHunkDecisions(
    normalizeEditorLineEndings(read.content),
    hunks,
    input.decisions,
    input.direction,
  );
  if (applied.status === 'mismatch') {
    return { status: 'failure', errorMessage: `hunk-mismatch:${applied.hunkIndex}` };
  }
  return writeDocumentIfClean(
    input.documents,
    input.identity,
    serializeEditorContent(applied.content, read.lineEnding),
    read.revision,
  );
};
