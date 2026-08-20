import { EditorView } from '@codemirror/view';
import type { EditorViewState } from './types';

export const captureEditorViewState = (view: EditorView): EditorViewState => {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const column = line.from === line.to ? 1 : (view.state.selection.main.head - line.from + 1);
  return {
    cursorLine: line.number,
    cursorColumn: column,
    scrollTop: view.scrollDOM.scrollTop,
    scrollLeft: view.scrollDOM.scrollLeft,
  };
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
