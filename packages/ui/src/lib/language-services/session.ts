import type {
  LanguageServicesAPI,
  PiariumLanguageServiceEvent,
  Subscription,
} from '@/lib/api/types';
import { LanguageServicesError } from '@/lib/api/language-errors';
import { getDocumentRegistry } from '@/lib/documents/session';
import type { DocumentIdentity } from '@/lib/documents/types';
import { subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import {
  clearLanguageDiagnosticsForWorkspace,
  replaceLanguageDiagnostics,
  resetLanguageDiagnostics,
} from './diagnostics-registry';
import { languageIdFromResourceId } from './language-id';

type OpenEditor = {
  identity: DocumentIdentity;
  languageId: string;
  count: number;
};

let bound: LanguageServicesAPI | null = null;
const openEditors = new Map<string, OpenEditor>();
const workspaceSubscriptions = new Map<string, Subscription>();
const documentSyncQueues = new Map<string, Promise<void>>();
let unsubscribeEndpoint: (() => void) | null = null;
let syncEpoch = 0;

const editorKey = (identity: DocumentIdentity): string => `${identity.workspaceId}\0${identity.resourceId}`;

const collectWorkspaceIds = (): Set<string> => {
  const workspaceIds = new Set<string>();
  for (const open of openEditors.values()) workspaceIds.add(open.identity.workspaceId);
  return workspaceIds;
};

const acceptedVersion = (workspaceId: string, resourceId: string, documentVersion: number): boolean => {
  try {
    const record = getDocumentRegistry().get({ workspaceId, resourceId });
    if (!record) return true;
    return record.localEditRevision === documentVersion;
  } catch {
    return true;
  }
};

const handleEvent = (event: PiariumLanguageServiceEvent): void => {
  if (event.kind !== 'diagnostics') return;
  replaceLanguageDiagnostics(
    event.workspaceId,
    event.languageId,
    event.resourceId,
    event.items,
    (resourceId, documentVersion) => acceptedVersion(event.workspaceId, resourceId, documentVersion),
  );
};

const ensureWorkspaceSubscription = (workspaceId: string): void => {
  if (!bound || workspaceSubscriptions.has(workspaceId)) return;
  workspaceSubscriptions.set(workspaceId, bound.subscribe(workspaceId, handleEvent));
};

const enqueueDocumentSync = (identity: DocumentIdentity, languageId: string, reason: 'open' | 'change' | 'close'): void => {
  const language = bound;
  if (!language) return;
  let record;
  try {
    record = getDocumentRegistry().get(identity);
  } catch {
    return;
  }
  const request = {
    resource: identity,
    languageId,
    documentVersion: record?.localEditRevision ?? 0,
    reason,
  };
  const payload = reason === 'change' && record?.lastChanges?.length
    ? { ...request, changes: record.lastChanges.map((change) => ({ ...change })) }
    : reason !== 'close' && record?.buffer !== undefined
      ? { ...request, content: record.buffer }
      : request;
  const key = editorKey(identity);
  const epoch = syncEpoch;
  const previous = documentSyncQueues.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      if (bound !== language || syncEpoch !== epoch) return;
      try {
        await language.syncDocument(payload);
      } catch (error) {
        if (error instanceof LanguageServicesError && error.reason === 'stale-completion') return;
      }
    })
    .finally(() => {
      if (documentSyncQueues.get(key) === next) documentSyncQueues.delete(key);
    });
  documentSyncQueues.set(key, next);
};

const resetLocalLanguageState = (): void => {
  syncEpoch += 1;
  documentSyncQueues.clear();
  unsubscribeEndpoint?.();
  unsubscribeEndpoint = null;
  const workspaceIds = collectWorkspaceIds();
  for (const subscription of workspaceSubscriptions.values()) subscription.close();
  workspaceSubscriptions.clear();
  openEditors.clear();
  for (const workspaceId of workspaceIds) {
    clearLanguageDiagnosticsForWorkspace(workspaceId);
  }
  resetLanguageDiagnostics();
};

export const bindLanguageServices = (language: LanguageServicesAPI): void => {
  if (bound === language) return;
  const previous = bound;
  const workspaceIds = collectWorkspaceIds();
  resetLocalLanguageState();
  if (previous && previous !== language) {
    for (const workspaceId of workspaceIds) {
      void previous.disposeWorkspace(workspaceId);
    }
  }
  bound = language;
  unsubscribeEndpoint = subscribeRuntimeEndpointWillChange(() => {
    for (const workspaceId of collectWorkspaceIds()) {
      void language.disposeWorkspace(workspaceId);
    }
  });
};

export const acquireLanguageDocument = (identity: DocumentIdentity): void => {
  if (!bound) return;
  const languageId = languageIdFromResourceId(identity.resourceId);
  if (languageId === 'plaintext') return;
  const key = editorKey(identity);
  const existing = openEditors.get(key);
  if (existing) {
    existing.count += 1;
    return;
  }
  openEditors.set(key, { identity, languageId, count: 1 });
  ensureWorkspaceSubscription(identity.workspaceId);
  enqueueDocumentSync(identity, languageId, 'open');
};

export const notifyLanguageDocumentChange = (identity: DocumentIdentity): void => {
  const open = openEditors.get(editorKey(identity));
  if (!open) return;
  enqueueDocumentSync(identity, open.languageId, 'change');
};

export const releaseLanguageDocument = (identity: DocumentIdentity): void => {
  const key = editorKey(identity);
  const existing = openEditors.get(key);
  if (!existing) return;
  existing.count -= 1;
  if (existing.count > 0) return;
  openEditors.delete(key);
  enqueueDocumentSync(identity, existing.languageId, 'close');
};

export const resetLanguageServices = (): void => {
  resetLocalLanguageState();
  bound = null;
};

export const getBoundLanguageServices = (): LanguageServicesAPI | null => bound;
