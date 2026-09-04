export type HarnessKnowledgeScope = 'workspace' | 'user';

export interface HarnessKnowledgeCandidate {
  id: number;
  content: string;
  trigger: string;
}

export interface HarnessKnowledgeSuggestion {
  id: number;
  scope: HarnessKnowledgeScope;
  content: string;
  trigger: string;
  createdAt: number;
  source?: { sessionId: string; kind: string };
  supersedesCandidates: HarnessKnowledgeCandidate[];
}

const recordOf = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const parseCandidate = (value: unknown): HarnessKnowledgeCandidate => {
  const candidate = recordOf(value);
  if (
    !candidate
    || !Number.isSafeInteger(candidate.id)
    || Number(candidate.id) <= 0
    || typeof candidate.content !== 'string'
    || typeof candidate.trigger !== 'string'
  ) throw new Error('Malformed knowledge supersedes candidate');
  return { id: Number(candidate.id), content: candidate.content, trigger: candidate.trigger };
};

export const parseHarnessKnowledgeSuggestions = (value: unknown): HarnessKnowledgeSuggestion[] => {
  const response = recordOf(value);
  if (!response || !Array.isArray(response.suggestions)) throw new Error('Malformed knowledge suggestions response');
  return response.suggestions.map((value) => {
    const suggestion = recordOf(value);
    const source = recordOf(suggestion?.source);
    if (
      !suggestion
      || !Number.isSafeInteger(suggestion.id)
      || Number(suggestion.id) <= 0
      || (suggestion.scope !== 'workspace' && suggestion.scope !== 'user')
      || suggestion.status !== 'suggested'
      || typeof suggestion.content !== 'string'
      || typeof suggestion.trigger !== 'string'
      || typeof suggestion.createdAt !== 'number'
      || !Number.isFinite(suggestion.createdAt)
      || !Array.isArray(suggestion.supersedesCandidates)
      || (source !== null && (typeof source.sessionId !== 'string' || typeof source.kind !== 'string'))
    ) throw new Error('Malformed knowledge suggestion');
    return {
      id: Number(suggestion.id),
      scope: suggestion.scope,
      content: suggestion.content,
      trigger: suggestion.trigger,
      createdAt: suggestion.createdAt,
      ...(source ? { source: { sessionId: source.sessionId as string, kind: source.kind as string } } : {}),
      supersedesCandidates: suggestion.supersedesCandidates.map(parseCandidate),
    };
  });
};

export const harnessKnowledgeKey = (suggestion: Pick<HarnessKnowledgeSuggestion, 'id' | 'scope'>): string => (
  `${suggestion.scope}:${suggestion.id}`
);
