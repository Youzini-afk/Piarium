import { EditorView } from '@codemirror/view';
import type { EditorViewState } from './types';

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
  return next;
};

export const applyEditorViewState = (view: EditorView, viewState: EditorViewState): void => {
  const { cursorLine, cursorColumn, scrollTop, scrollLeft } = viewState;
  if (cursorLine && cursorLine >= 1) {
    const lineNumber = Math.min(cursorLine, view.state.doc.lines);
    const line = view.state.doc.line(lineNumber);
    const column = Math.max(0, (cursorColumn ?? 1) - 1);
    const pos = Math.min(line.from + column, line.to);
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  }
  if (typeof scrollTop === 'number') view.scrollDOM.scrollTop = scrollTop;
  if (typeof scrollLeft === 'number') view.scrollDOM.scrollLeft = scrollLeft;
};
