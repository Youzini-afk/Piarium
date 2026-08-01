import type { QuestionRequest, PermissionRequest } from '@opencode-ai/sdk/v2/client';
import type { StoreApi } from 'zustand';

import { opencodeClient } from '@/lib/opencode/client';
import type { DirectoryStore } from './child-store';
import { autoAcceptGroupedPermissions } from './permission-auto-accept';
import * as sessionActions from './session-actions';

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const requestSignature = (items: Array<{ id: string }> | undefined): string => {
  if (!items || items.length === 0) return '';
  return items
    .map((item) => item.id)
    .sort(cmp)
    .join('|');
};

export async function resyncBlockingRequestsForDirectory(
  directory: string,
  store: StoreApi<DirectoryStore>,
  candidateSessionIds?: string[],
) {
  const before = store.getState();
  const knownSessionIds = new Set<string>([
    ...before.session.map((session) => session.id),
    ...Object.keys(before.message ?? {}),
    ...Object.keys(before.session_status ?? {}),
    ...Object.keys(before.question ?? {}),
    ...Object.keys(before.permission ?? {}),
  ]);
  const candidates = candidateSessionIds ?? Array.from(knownSessionIds);
  if (candidates.length === 0) return;

  try {
    const beforeSignatures = new Map(
      candidates.map((sessionId) => [sessionId, requestSignature(before.question[sessionId])]),
    );
    const pendingQuestions = await opencodeClient.listPendingQuestions({ directories: [directory] });
    const grouped: Record<string, QuestionRequest[]> = {};
    for (const question of pendingQuestions) {
      if (!question?.id || !question.sessionID) continue;
      if (!knownSessionIds.has(question.sessionID)) continue;
      const list = grouped[question.sessionID];
      if (list) list.push(question);
      else grouped[question.sessionID] = [question];
    }
    for (const sessionId of Object.keys(grouped)) {
      grouped[sessionId].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }

    store.setState((state: DirectoryStore) => {
      const merged = { ...state.question };
      for (const [sessionId, questions] of Object.entries(grouped)) {
        merged[sessionId] = questions;
      }
      for (const sessionId of candidates) {
        if (grouped[sessionId]) continue;
        const beforeSignature = beforeSignatures.get(sessionId) ?? '';
        const currentSignature = requestSignature(state.question[sessionId]);
        if (currentSignature !== beforeSignature) continue;
        delete merged[sessionId];
      }
      return { question: merged };
    });
  } catch {
    // Non-fatal: question resync best-effort.
  }

  try {
    const beforeSignatures = new Map(
      candidates.map((sessionId) => [sessionId, requestSignature(before.permission[sessionId])]),
    );
    const pendingPermissions = await opencodeClient.listPendingPermissions({ directories: [directory] });
    const grouped: Record<string, PermissionRequest[]> = {};
    for (const permission of pendingPermissions) {
      if (!permission?.id || !permission.sessionID) continue;
      if (!knownSessionIds.has(permission.sessionID)) continue;
      const list = grouped[permission.sessionID];
      if (list) list.push(permission);
      else grouped[permission.sessionID] = [permission];
    }
    for (const sessionId of Object.keys(grouped)) {
      grouped[sessionId].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }

    const visibleGrouped = await autoAcceptGroupedPermissions(grouped, (permission) =>
      sessionActions.respondToPermission(permission.sessionID, permission.id, 'once'));

    store.setState((state: DirectoryStore) => {
      const merged = { ...state.permission };
      for (const [sessionId, permissions] of Object.entries(visibleGrouped)) {
        merged[sessionId] = permissions;
      }
      for (const sessionId of candidates) {
        if (visibleGrouped[sessionId]) continue;
        const beforeSignature = beforeSignatures.get(sessionId) ?? '';
        const currentSignature = requestSignature(state.permission[sessionId]);
        if (currentSignature !== beforeSignature) continue;
        delete merged[sessionId];
      }
      return { permission: merged };
    });
  } catch {
    // Non-fatal: permission resync best-effort.
  }
}
