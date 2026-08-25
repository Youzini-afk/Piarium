import type { PiariumLanguageWorkspaceEdit } from '@/lib/api/types';
import type {
  DocumentWorkspaceEditInput,
  DocumentWorkspaceResourceOperation,
  DocumentWorkspaceTextDocumentEdit,
} from '@/lib/documents/types';

export const toDocumentWorkspaceEditInput = (
  workspaceId: string,
  origin: string,
  edit: PiariumLanguageWorkspaceEdit,
): DocumentWorkspaceEditInput => {
  const textEdits: DocumentWorkspaceTextDocumentEdit[] = [];
  const resourceOperations: DocumentWorkspaceResourceOperation[] = [];
  for (const change of edit.documentChanges) {
    if (change.kind === 'text') {
      textEdits.push({
        identity: change.resource,
        version: change.version,
        edits: change.edits.map((item) => ({
          range: item.range,
          newText: item.newText,
          ...(item.annotationId ? { annotationId: item.annotationId } : {}),
        })),
      });
      continue;
    }
    if (change.kind === 'create') {
      resourceOperations.push({ kind: 'create', identity: change.resource });
    } else if (change.kind === 'rename') {
      resourceOperations.push({ kind: 'rename', from: change.from, to: change.to });
    } else {
      resourceOperations.push({ kind: 'delete', identity: change.resource });
    }
  }
  return {
    workspaceId,
    origin,
    textEdits,
    ...(resourceOperations.length ? { resourceOperations } : {}),
    ...(edit.changeAnnotations ? { changeAnnotations: edit.changeAnnotations } : {}),
  };
};
