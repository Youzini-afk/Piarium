import type { SessionSnapshot } from '@piarium/protocol';
import { createPiSessionFromNavigation, type PiSessionCreateTarget } from './sessionNavigation';
import { usePiDraftStore } from '@/stores/usePiDraftStore';
import { usePiSessionStore, type PiSessionStoreState } from '@/stores/usePiSessionStore';

interface PiSessionDraftSeed {
  instructions?: string;
  text: string;
}

interface PiSessionDraftTarget {
  directory: string;
  sessionKey: string;
}

export const joinPiDraftInstructions = (
  ...parts: Array<string | null | undefined>
): string | undefined => {
  const joined = parts
    .map((part) => part?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n');
  return joined || undefined;
};

export const resolveExistingPiSessionDraftTarget = (
  state: Pick<PiSessionStoreState, 'currentSessionId' | 'records' | 'summaries'>,
  fallbackDirectory?: string | null,
): PiSessionDraftTarget | null => {
  const sessionId = state.currentSessionId;
  if (!sessionId) return null;
  const directory = state.records[sessionId]?.snapshot?.cwd?.trim()
    || state.summaries.find((summary) => summary.id === sessionId)?.cwd.trim()
    || fallbackDirectory?.trim()
    || '';
  return directory ? { directory, sessionKey: sessionId } : null;
};

export const stagePiSessionDraft = (
  sessionId: string,
  seed: PiSessionDraftSeed,
): void => {
  usePiDraftStore.getState().setDraft(sessionId, {
    instructions: joinPiDraftInstructions(seed.instructions),
    text: seed.text,
  });
};

export const createPiSessionWithDraft = async (
  target: PiSessionCreateTarget,
  seed: PiSessionDraftSeed,
): Promise<SessionSnapshot> => {
  const snapshot = await createPiSessionFromNavigation(target);
  stagePiSessionDraft(snapshot.sessionId, seed);
  return snapshot;
};

export const ensurePiSessionDraftTarget = async (
  fallbackDirectory?: string | null,
): Promise<PiSessionDraftTarget> => {
  const existing = resolveExistingPiSessionDraftTarget(
    usePiSessionStore.getState(),
    fallbackDirectory,
  );
  if (existing) return existing;
  const snapshot = await createPiSessionFromNavigation({ directory: fallbackDirectory });
  return { directory: snapshot.cwd, sessionKey: snapshot.sessionId };
};
