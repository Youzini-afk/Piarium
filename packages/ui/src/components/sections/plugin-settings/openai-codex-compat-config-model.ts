import { hasJsonPath, readJsonPath, type JsonObject } from './plugin-config-model';

export type OpenAICodexCompatDraftIssueCode =
  | 'invalid-boolean'
  | 'invalid-number'
  | 'invalid-value';

export interface OpenAICodexCompatDraftIssue {
  code: OpenAICodexCompatDraftIssueCode;
  field: string;
}

const BOOLEAN_FIELDS = [
  'fastMode',
  'responsesLite',
  'applyPatch',
  'imageGeneration',
  'webRun',
] as const;

const ENUM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  imageDetail: ['auto', 'low', 'high', 'original'],
  reasoningMode: ['standard', 'pro'],
  reasoningSummary: ['auto', 'concise', 'detailed', 'off'],
  textVerbosity: ['low', 'medium', 'high'],
  toolBackground: ['subtle', 'status', 'none'],
  webSearch: ['disabled', 'cached', 'indexed', 'live'],
};

export const openAICodexCompatDraftIssue = (
  draft: JsonObject,
): OpenAICodexCompatDraftIssue | null => {
  for (const field of BOOLEAN_FIELDS) {
    if (hasJsonPath(draft, [field]) && typeof readJsonPath(draft, [field]) !== 'boolean') {
      return { code: 'invalid-boolean', field };
    }
  }

  for (const [field, values] of Object.entries(ENUM_FIELDS)) {
    const value = readJsonPath(draft, [field]);
    if (hasJsonPath(draft, [field]) && (typeof value !== 'string' || !values.includes(value))) {
      return { code: 'invalid-value', field };
    }
  }

  if (hasJsonPath(draft, ['autoCompactAtPercent'])) {
    const value = readJsonPath(draft, ['autoCompactAtPercent']);
    if (value !== null && (
      typeof value !== 'number'
      || !Number.isFinite(value)
      || value <= 0
      || value > 100
    )) {
      return { code: 'invalid-number', field: 'autoCompactAtPercent' };
    }
  }

  return null;
};
