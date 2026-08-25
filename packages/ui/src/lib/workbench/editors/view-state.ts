import { foldEffect, foldable, foldedRanges } from '@codemirror/language';
import { EditorView } from '@codemirror/view';

import type { EditorViewState } from './types';
import {
  createLegacyTextEditorViewState,
  legacyTextValueFromViewState,
  type LegacyTextViewState,
} from './view-state-core';

const positionFor = (view: EditorView, lineNumber: number, columnNumber: number): number => {
  const line = view.state.doc.line(Math.min(Math.max(1, lineNumber), view.state.doc.lines));
  return Math.min(line.from + Math.max(0, columnNumber - 1), line.to);
};
export const captureEditorViewState = (view: EditorView): EditorViewState => {
  const range = view.state.selection.main;
  const headLine = view.state.doc.lineAt(range.head);
  const fromLine = view.state.doc.lineAt(range.from);
  const toLine = view.state.doc.lineAt(range.to);
  const value: LegacyTextViewState = {
    cursorLine: headLine.number,
    cursorColumn: range.head - headLine.from + 1,
    scrollTop: view.scrollDOM.scrollTop,
    scrollLeft: view.scrollDOM.scrollLeft,
  };
  if (range.from !== range.to) {
    value.selectionStartLine = fromLine.number;
    value.selectionStartColumn = range.from - fromLine.from + 1;
    value.selectionEndLine = toLine.number;
    value.selectionEndColumn = range.to - toLine.from + 1;
  }
  const foldedLines = new Set<number>();
  foldedRanges(view.state).between(0, view.state.doc.length, (from) => {
    foldedLines.add(view.state.doc.lineAt(from).number);
  });
  if (foldedLines.size > 0) value.foldedLines = [...foldedLines];
  return createLegacyTextEditorViewState(value);
};

export const applyEditorViewState = (view: EditorView, viewState: EditorViewState): void => {
  const value = legacyTextValueFromViewState(viewState);
  if (!value) return;
  if (
    value.selectionStartLine
    && value.selectionStartColumn
    && value.selectionEndLine
    && value.selectionEndColumn
  ) {
    view.dispatch({
      selection: {
        anchor: positionFor(view, value.selectionStartLine, value.selectionStartColumn),
        head: positionFor(view, value.selectionEndLine, value.selectionEndColumn),
      },
      scrollIntoView: true,
    });
  } else if (value.cursorLine) {
    const pos = positionFor(view, value.cursorLine, value.cursorColumn ?? 1);
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  }
  const effects = (value.foldedLines ?? []).flatMap((lineNumber) => {
    if (lineNumber > view.state.doc.lines) return [];
    const line = view.state.doc.line(lineNumber);
    const range = foldable(view.state, line.from, line.to);
    return range ? [foldEffect.of(range)] : [];
  });
  if (effects.length > 0) view.dispatch({ effects });
  if (typeof value.scrollTop === 'number') view.scrollDOM.scrollTop = value.scrollTop;
  if (typeof value.scrollLeft === 'number') view.scrollDOM.scrollLeft = value.scrollLeft;
};
