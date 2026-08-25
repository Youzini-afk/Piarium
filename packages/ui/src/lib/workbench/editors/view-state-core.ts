import type { JsonObject, JsonValue } from '@piarium/extension-contract';

import { BUILTIN_EDITOR_PROVIDER_IDS, type EditorViewState } from './types';

export type TextEditorPosition = { line: number; column: number };
export type TextEditorSelection = { start: TextEditorPosition; end: TextEditorPosition };
export type TextEditorViewStateSummary = {
  cursor: TextEditorPosition;
  selection?: TextEditorSelection;
};

export type LegacyTextViewState = {
  cursorLine?: number;
  cursorColumn?: number;
  scrollTop?: number;
  scrollLeft?: number;
  selectionStartLine?: number;
  selectionStartColumn?: number;
  selectionEndLine?: number;
  selectionEndColumn?: number;
  foldedLines?: number[];
};

export const TEXT_EDITOR_VIEW_STATE_PROVIDER_ID = BUILTIN_EDITOR_PROVIDER_IDS.text;
export const LEGACY_TEXT_EDITOR_VIEW_STATE_SCHEMA_VERSION = 1;
export const MONACO_TEXT_EDITOR_VIEW_STATE_SCHEMA_VERSION = 2;

export const isJsonObject = (value: JsonValue | undefined): value is JsonObject => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const positiveInteger = (value: JsonValue | undefined): number | undefined => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : undefined
);

const nonNegativeNumber = (value: JsonValue | undefined): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
);

export const legacyTextValueFromViewState = (
  viewState: EditorViewState,
): LegacyTextViewState | undefined => {
  const provider = viewState.providerState;
  if (
    !provider
    || provider.providerId !== TEXT_EDITOR_VIEW_STATE_PROVIDER_ID
    || provider.schemaVersion !== LEGACY_TEXT_EDITOR_VIEW_STATE_SCHEMA_VERSION
    || !isJsonObject(provider.value)
  ) return undefined;
  const value = provider.value;
  const foldedLines = Array.isArray(value.foldedLines)
    ? value.foldedLines.filter((line): line is number => positiveInteger(line) !== undefined)
    : undefined;
  return {
    cursorLine: positiveInteger(value.cursorLine),
    cursorColumn: positiveInteger(value.cursorColumn),
    scrollTop: nonNegativeNumber(value.scrollTop),
    scrollLeft: nonNegativeNumber(value.scrollLeft),
    selectionStartLine: positiveInteger(value.selectionStartLine),
    selectionStartColumn: positiveInteger(value.selectionStartColumn),
    selectionEndLine: positiveInteger(value.selectionEndLine),
    selectionEndColumn: positiveInteger(value.selectionEndColumn),
    ...(foldedLines?.length ? { foldedLines } : {}),
  };
};

const positionFrom = (value: JsonValue | undefined): TextEditorPosition | undefined => {
  if (!isJsonObject(value)) return undefined;
  const line = positiveInteger(value.line);
  const column = positiveInteger(value.column);
  return line && column ? { line, column } : undefined;
};

export const textEditorSummaryFromViewState = (
  viewState: EditorViewState,
): TextEditorViewStateSummary | undefined => {
  const provider = viewState.providerState;
  if (!provider || provider.providerId !== TEXT_EDITOR_VIEW_STATE_PROVIDER_ID) return undefined;
  if (provider.schemaVersion === LEGACY_TEXT_EDITOR_VIEW_STATE_SCHEMA_VERSION) {
    const legacy = legacyTextValueFromViewState(viewState);
    if (!legacy?.cursorLine) return undefined;
    const cursor = { line: legacy.cursorLine, column: legacy.cursorColumn ?? 1 };
    const start = legacy.selectionStartLine
      ? { line: legacy.selectionStartLine, column: legacy.selectionStartColumn ?? 1 }
      : undefined;
    const end = legacy.selectionEndLine
      ? { line: legacy.selectionEndLine, column: legacy.selectionEndColumn ?? 1 }
      : undefined;
    return { cursor, ...(start && end ? { selection: { start, end } } : {}) };
  }
  if (provider.schemaVersion !== MONACO_TEXT_EDITOR_VIEW_STATE_SCHEMA_VERSION || !isJsonObject(provider.value)) {
    return undefined;
  }
  const summary = isJsonObject(provider.value.summary) ? provider.value.summary : undefined;
  const cursor = positionFrom(summary?.cursor);
  if (!cursor) return undefined;
  const selectionValue = isJsonObject(summary?.selection) ? summary.selection : undefined;
  const start = positionFrom(selectionValue?.start);
  const end = positionFrom(selectionValue?.end);
  return { cursor, ...(start && end ? { selection: { start, end } } : {}) };
};

export const createLegacyTextEditorViewState = (
  value: LegacyTextViewState,
): EditorViewState => {
  const serialized: JsonObject = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (candidate !== undefined) serialized[key] = candidate;
  }
  return {
    providerState: {
      providerId: TEXT_EDITOR_VIEW_STATE_PROVIDER_ID,
      schemaVersion: LEGACY_TEXT_EDITOR_VIEW_STATE_SCHEMA_VERSION,
      value: serialized,
    },
  };
};

