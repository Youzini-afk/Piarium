import { EditorView } from '@codemirror/view';
import { foldEffect, foldable, foldedRanges } from '@codemirror/language';
import type { EditorViewState } from './types';

const positionFor = (view: EditorView, lineNumber: number, columnNumber: number): number => {
  const line = view.state.doc.line(Math.min(Math.max(1, lineNumber), view.state.doc.lines));
  return Math.min(line.from + Math.max(0, columnNumber - 1), line.to);
};

export const captureEditorViewState = (view: EditorView): EditorViewState => {
  const range = view.state.selection.main;
  const headLine = view.state.doc.lineAt(range.head);
  const column = headLine.from === headLine.to ? 1 : (range.head - headLine.from + 1);
  const fromLine = view.state.doc.lineAt(range.from);
  const toLine = view.state.doc.lineAt(range.to);
  const next: EditorViewState = {
    cursorLine: headLine.number,
    cursorColumn: column,
    scrollTop: view.scrollDOM.scrollTop,
    scrollLeft: view.scrollDOM.scrollLeft,
  };
  if (range.from !== range.to) {
    next.selectionStartLine = fromLine.number;
    next.selectionStartColumn = range.from - fromLine.from + 1;
    next.selectionEndLine = toLine.number;
    next.selectionEndColumn = range.to - toLine.from + 1;
  }
  const foldedLines = new Set<number>();
  foldedRanges(view.state).between(0, view.state.doc.length, (from) => {
    foldedLines.add(view.state.doc.lineAt(from).number);
  });
  if (foldedLines.size > 0) next.foldedLines = [...foldedLines];
  return next;
};

export const applyEditorViewState = (view: EditorView, viewState: EditorViewState): void => {
  const { cursorLine, cursorColumn, scrollTop, scrollLeft } = viewState;
  if (
    viewState.selectionStartLine
    && viewState.selectionStartColumn
    && viewState.selectionEndLine
    && viewState.selectionEndColumn
  ) {
    view.dispatch({
      selection: {
        anchor: positionFor(view, viewState.selectionStartLine, viewState.selectionStartColumn),
        head: positionFor(view, viewState.selectionEndLine, viewState.selectionEndColumn),
      },
      scrollIntoView: true,
    });
  } else if (cursorLine && cursorLine >= 1) {
    const pos = positionFor(view, cursorLine, cursorColumn ?? 1);
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  }
  const effects = (viewState.foldedLines ?? []).flatMap((lineNumber) => {
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || lineNumber > view.state.doc.lines) return [];
    const line = view.state.doc.line(lineNumber);
    const range = foldable(view.state, line.from, line.to);
    return range ? [foldEffect.of(range)] : [];
  });
  if (effects.length > 0) {
    view.dispatch({ effects });
  }
  if (typeof scrollTop === 'number') view.scrollDOM.scrollTop = scrollTop;
  if (typeof scrollLeft === 'number') view.scrollDOM.scrollLeft = scrollLeft;
};
