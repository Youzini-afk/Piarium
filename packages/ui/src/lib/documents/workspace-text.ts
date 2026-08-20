import type { DocumentsAPI, PiariumDocumentReadResult } from '@/lib/api/types';
import { DocumentsError } from '@/lib/api/documents-errors';
import { documentIdentityForPath } from './path';
import type { DocumentIdentity } from './types';

export const resolveTextDocumentIdentity = async (
  documents: DocumentsAPI,
  workspaceRoot: string,
  filePath: string,
): Promise<DocumentIdentity> => {
  const workspace = await documents.resolveWorkspace({ path: workspaceRoot });
  const identity = documentIdentityForPath(workspace.workspaceId, workspaceRoot, filePath);
  if (!identity) {
    throw new DocumentsError('Path is outside the workspace', { reason: 'path-escape' });
  }
  return identity;
};

const textFromRead = (result: PiariumDocumentReadResult): string | null => {
  if (result.status === 'missing') return null;
  if (result.status === 'ready') return result.content;
  throw new DocumentsError(
    result.status === 'binary' ? 'Binary files cannot be read as text' : 'Unsupported document encoding',
    { reason: 'failed' },
  );
};

export const readWorkspaceTextFile = async (
  documents: DocumentsAPI,
  workspaceRoot: string,
  filePath: string,
): Promise<string | null> => {
  const resource = await resolveTextDocumentIdentity(documents, workspaceRoot, filePath);
  return textFromRead(await documents.read(resource));
};

export const writeWorkspaceTextFile = async (
  documents: DocumentsAPI,
  workspaceRoot: string,
  filePath: string,
  content: string,
): Promise<boolean> => {
  const resource = await resolveTextDocumentIdentity(documents, workspaceRoot, filePath);
  const current = await documents.read(resource);
  if (current.status === 'binary' || current.status === 'unsupported-encoding') return false;
  const encoding = current.status === 'ready' ? current.encoding : 'utf-8';
  const bom = current.status === 'ready' ? current.bom : false;
  const expectedRevision = current.status === 'missing' ? null : current.revision;
  const written = await documents.write({
    resource,
    content,
    encoding,
    bom,
    expectedRevision,
    operationId: crypto.randomUUID(),
  });
  if (written.status === 'written') return true;
  const latest = await documents.read(resource);
  if (latest.status === 'missing') {
    const created = await documents.write({
      resource,
      content,
      encoding,
      bom,
      expectedRevision: null,
      operationId: crypto.randomUUID(),
    });
    return created.status === 'written';
  }
  if (latest.status !== 'ready') return false;
  const retried = await documents.write({
    resource,
    content,
    encoding,
    bom,
    expectedRevision: latest.revision,
    operationId: crypto.randomUUID(),
  });
  return retried.status === 'written';
};
