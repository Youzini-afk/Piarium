export type DocumentIdentity = {
  workspaceId: string;
  resourceId: string;
};

export const documentKey = (identity: DocumentIdentity): string => (
  `${identity.workspaceId}\0${identity.resourceId}`
);

export type DocumentLineEnding = 'lf' | 'crlf' | 'cr';

export type DocumentLoadStatus =
  | 'unloaded'
  | 'loading'
  | 'ready'
  | 'missing'
  | 'binary'
  | 'unsupported-encoding'
  | 'deleted'
  | 'error'
  | 'conflict';

export type DocumentChange = {
  from: number;
  to: number;
  insert: string;
};

export type DocumentConflictState = {
  diskRevision: string;
};

export type DocumentRecord = {
  identity: DocumentIdentity;
  connectionGeneration: number;
  status: DocumentLoadStatus;
  dirty: boolean;
  saving: boolean;
  baseContent: string;
  buffer: string;
  baseRevision: string | null;
  localEditRevision: number;
  encoding: string;
  bom: boolean;
  lineEnding: DocumentLineEnding;
  byteLength: number;
  saveOperationId: string | null;
  saveCapturedEditRevision: number | null;
  conflict: DocumentConflictState | null;
  errorMessage: string | null;
  recoveryJournalId: string | null;
  recoveryJournalRevision: number | null;
  lastOrigin: string | null;
  lastChanges: DocumentChange[] | null;
};

export type DocumentMeta = {
  identity: DocumentIdentity;
  status: DocumentLoadStatus;
  dirty: boolean;
  saving: boolean;
  localEditRevision: number;
  baseRevision: string | null;
  encoding: string;
  bom: boolean;
  lineEnding: DocumentLineEnding;
  byteLength: number;
  errorMessage: string | null;
  conflict: DocumentConflictState | null;
};

export const toDocumentMeta = (record: DocumentRecord): DocumentMeta => ({
  identity: record.identity,
  status: record.status,
  dirty: record.dirty,
  saving: record.saving,
  localEditRevision: record.localEditRevision,
  baseRevision: record.baseRevision,
  encoding: record.encoding,
  bom: record.bom,
  lineEnding: record.lineEnding,
  byteLength: record.byteLength,
  errorMessage: record.errorMessage,
  conflict: record.conflict,
});
