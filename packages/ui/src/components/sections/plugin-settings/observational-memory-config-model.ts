import { hasJsonPath, readJsonPath, type JsonObject } from './plugin-config-model';

export type ObservationalMemoryDraftIssueCode =
  | 'invalid-boolean'
  | 'invalid-number'
  | 'invalid-value'
  | 'required';

export interface ObservationalMemoryDraftIssue {
  code: ObservationalMemoryDraftIssueCode;
  field: string;
}

const POSITIVE_INTEGER_FIELDS = [
  'observeAfterTokens',
  'reflectAfterTokens',
  'observerChunkMaxTokens',
  'compactAfterTokens',
  'observationsPoolMaxTokens',
  'observationsPoolTargetTokens',
  'agentMaxTurns',
] as const;

const BOOLEAN_FIELDS = [
  'showWorkerNotifications',
  'passive',
  'debugLog',
] as const;

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

export const observationalMemoryDraftIssue = (
  draft: JsonObject,
): ObservationalMemoryDraftIssue | null => {
  for (const field of POSITIVE_INTEGER_FIELDS) {
    if (!hasJsonPath(draft, [field])) continue;
    const value = readJsonPath(draft, [field]);
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      return { code: 'invalid-number', field };
    }
  }

  for (const field of BOOLEAN_FIELDS) {
    if (hasJsonPath(draft, [field]) && typeof readJsonPath(draft, [field]) !== 'boolean') {
      return { code: 'invalid-boolean', field };
    }
  }

  if (hasJsonPath(draft, ['compactAfterTokensMode'])) {
    const value = readJsonPath(draft, ['compactAfterTokensMode']);
    if (value !== 'calibrated' && value !== 'ratio') {
      return { code: 'invalid-value', field: 'compactAfterTokensMode' };
    }
  }

  if (hasJsonPath(draft, ['compactAfterTokensRatio'])) {
    const value = readJsonPath(draft, ['compactAfterTokensRatio']);
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) {
      return { code: 'invalid-number', field: 'compactAfterTokensRatio' };
    }
  }

  const poolMaximum = readJsonPath(draft, ['observationsPoolMaxTokens']);
  const poolTarget = readJsonPath(draft, ['observationsPoolTargetTokens']);
  if (
    typeof poolMaximum === 'number'
    && typeof poolTarget === 'number'
    && poolTarget >= poolMaximum
  ) {
    return { code: 'invalid-value', field: 'observationsPoolTargetTokens' };
  }

  if (hasJsonPath(draft, ['model'])) {
    const model = readJsonPath(draft, ['model']);
    if (!isObject(model)) return { code: 'invalid-value', field: 'model' };
    if (typeof model.provider !== 'string' || model.provider.length === 0) {
      return { code: 'required', field: 'model.provider' };
    }
    if (typeof model.id !== 'string' || model.id.length === 0) {
      return { code: 'required', field: 'model.id' };
    }
    if (
      Object.prototype.hasOwnProperty.call(model, 'thinking')
      && (typeof model.thinking !== 'string' || !THINKING_LEVELS.includes(model.thinking as typeof THINKING_LEVELS[number]))
    ) {
      return { code: 'invalid-value', field: 'model.thinking' };
    }
  }

  return null;
};
