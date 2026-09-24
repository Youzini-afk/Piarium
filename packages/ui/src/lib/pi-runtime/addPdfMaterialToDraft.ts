import type { ImageAttachment, WebDocumentRegion } from '@varin/protocol';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { readPiDraft, usePiDraftStore } from '@/stores/usePiDraftStore';
import { getRuntimeKey } from '@varin/application-client';
import { useUIStore } from '@/stores/useUIStore';
import { buildPdfMaterialCitationMarkdown } from './pdfMaterialCitation';

export type AddPdfMaterialToDraftResult = 'added' | 'session-missing' | 'session-changed' | 'runtime-changed';

export const addPdfMaterialRegionToDraft = (input: {
  sessionId: string;
  snapshotId: string;
  title: string;
  page: number;
  sourceHash: string;
  region: WebDocumentRegion;
  image: ImageAttachment;
  analysisId?: string;
  runtimeKey?: string;
}): AddPdfMaterialToDraftResult => {
  const activeSessionId = usePiSessionStore.getState().currentSessionId;
  if (!activeSessionId) return 'session-missing';
  if (activeSessionId !== input.sessionId) return 'session-changed';
  const activeRuntimeKey = getRuntimeKey();
  if (input.runtimeKey && activeRuntimeKey !== input.runtimeKey) return 'runtime-changed';
  const runtimeKey = input.runtimeKey ?? activeRuntimeKey;
  const current = readPiDraft(input.sessionId, runtimeKey);
  const citation = buildPdfMaterialCitationMarkdown(input.title, {
    snapshotId: input.snapshotId,
    page: input.page,
    sourceHash: input.sourceHash,
    ...(input.analysisId ? { analysisId: input.analysisId } : {}),
    region: input.region,
  });
  usePiDraftStore.getState().setDraft(input.sessionId, {
    text: [current.text.trimEnd(), citation].filter(Boolean).join('\n\n'),
    images: [...current.images, input.image],
  }, runtimeKey);
  const ui = useUIStore.getState();
  ui.setActiveMainTab('chat');
  ui.setSessionSwitcherOpen(false);
  queueMicrotask(focusChatInput);
  return 'added';
};
