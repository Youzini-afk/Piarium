import type { HarnessKnowledgeScope } from './harnessKnowledgePresentation';

export const knowledgeSuggestionEndpoint = (sessionId: string): string => (
  `/api/harness/sessions/${encodeURIComponent(sessionId)}/knowledge/suggestions`
);

export const knowledgeSuggestionPayload = (
  scope: HarnessKnowledgeScope,
  content: string,
  kind: string,
): { scope: HarnessKnowledgeScope; content: string; trigger: string; kind: string } => ({
  scope,
  content,
  trigger: '',
  kind,
});
