import type { editor } from 'monaco-editor/editor';

import type { MonacoRuntime } from './runtime';

type VimMode = 'insert' | 'normal' | 'visual' | 'visual-line';

type VimAdapterOptions = {
  commandAriaLabel: string;
  editor: editor.IStandaloneCodeEditor;
  monaco: MonacoRuntime;
  onSave(): void;
  statusNode: HTMLElement;
};

type PiariumMonacoVimAdapter = {
  dispose(): void;
  mode(): VimMode;
};

const clamp = (value: number, minimum: number, maximum: number): number => (
  Math.min(Math.max(value, minimum), maximum)
);

export const createPiariumMonacoVimAdapter = (
  options: VimAdapterOptions,
): PiariumMonacoVimAdapter => {
  const { commandAriaLabel, editor: editorInstance, monaco, onSave, statusNode } = options;
  const modeNode = document.createElement('span');
  const keyNode = document.createElement('span');
  keyNode.className = 'ml-auto';
  statusNode.replaceChildren(modeNode, keyNode);
  let mode: VimMode = 'normal';
  let pending = '';
  let count = 0;
  let pendingCount = 1;
  let register = '';
  let registerLinewise = false;
  let visualAnchor: import('monaco-editor/editor').Position | null = null;
  const originalOptions = editorInstance.getRawOptions();
  const originalCursorBlinking = originalOptions.cursorBlinking;
  const originalCursorStyle = originalOptions.cursorStyle;

  const model = (): editor.ITextModel | null => editorInstance.getModel();
  const position = (): import('monaco-editor/editor').Position | null => editorInstance.getPosition();
  const normalMaxColumn = (lineNumber: number): number => {
    const current = model();
    if (!current) return 1;
    return Math.max(1, current.getLineMaxColumn(lineNumber) - 1);
  };
  const updateStatus = (): void => {
    modeNode.textContent = mode === 'normal'
      ? '-- NORMAL --'
      : mode === 'insert'
        ? '-- INSERT --'
        : mode === 'visual-line'
          ? '-- VISUAL LINE --'
          : '-- VISUAL --';
    keyNode.textContent = `${count > 0 ? count : ''}${pending}`;
  };
  const setMode = (next: VimMode): void => {
    mode = next;
    pending = '';
    count = 0;
    if (next !== 'visual' && next !== 'visual-line') visualAnchor = null;
    editorInstance.updateOptions({
      cursorBlinking: next === 'insert' ? (originalCursorBlinking ?? 'blink') : 'solid',
      cursorStyle: next === 'insert' ? (originalCursorStyle ?? 'line') : 'block',
    });
    updateStatus();
  };
  const moveTo = (lineNumber: number, column: number, reveal = true): void => {
    const current = model();
    if (!current) return;
    const line = clamp(lineNumber, 1, current.getLineCount());
    const maximum = mode === 'insert'
      ? current.getLineMaxColumn(line)
      : normalMaxColumn(line);
    const next = new monaco.Position(line, clamp(column, 1, maximum));
    if ((mode === 'visual' || mode === 'visual-line') && visualAnchor) {
      if (mode === 'visual-line') {
        const startLine = Math.min(visualAnchor.lineNumber, next.lineNumber);
        const endLine = Math.max(visualAnchor.lineNumber, next.lineNumber);
        editorInstance.setSelection(new monaco.Selection(
          startLine,
          1,
          endLine,
          current.getLineMaxColumn(endLine),
        ));
      } else {
        editorInstance.setSelection(new monaco.Selection(
          visualAnchor.lineNumber,
          visualAnchor.column,
          next.lineNumber,
          next.column,
        ));
      }
    } else {
      editorInstance.setPosition(next);
    }
    if (reveal) editorInstance.revealPositionInCenterIfOutsideViewport(next);
  };
  const enterInsert = (at: import('monaco-editor/editor').Position | null): void => {
    setMode('insert');
    if (at) editorInstance.setPosition(at);
    editorInstance.focus();
  };
  const executeEdit = (range: import('monaco-editor/editor').IRange, text: string): void => {
    editorInstance.pushUndoStop();
    editorInstance.executeEdits('piarium.vim', [{ range, text, forceMoveMarkers: true }]);
    editorInstance.pushUndoStop();
  };
  const currentLineRange = (lineCount = 1): import('monaco-editor/editor').Range | null => {
    const current = model();
    const cursor = position();
    if (!current || !cursor) return null;
    const lastLine = Math.min(current.getLineCount(), cursor.lineNumber + lineCount - 1);
    if (lastLine < current.getLineCount()) {
      return new monaco.Range(cursor.lineNumber, 1, lastLine + 1, 1);
    }
    if (cursor.lineNumber > 1) {
      return new monaco.Range(
        cursor.lineNumber - 1,
        current.getLineMaxColumn(cursor.lineNumber - 1),
        lastLine,
        current.getLineMaxColumn(lastLine),
      );
    }
    return new monaco.Range(1, 1, 1, current.getLineMaxColumn(1));
  };
  const deleteSelection = (): void => {
    const selection = editorInstance.getSelection();
    if (!selection || selection.isEmpty()) return;
    register = model()?.getValueInRange(selection) ?? '';
    registerLinewise = mode === 'visual-line';
    const start = selection.getStartPosition();
    executeEdit(selection, '');
    setMode('normal');
    moveTo(start.lineNumber, start.column);
  };
  const yankSelection = (): void => {
    const selection = editorInstance.getSelection();
    if (!selection || selection.isEmpty()) return;
    register = model()?.getValueInRange(selection) ?? '';
    registerLinewise = mode === 'visual-line';
    const start = selection.getStartPosition();
    setMode('normal');
    moveTo(start.lineNumber, start.column);
  };
  const openCommand = (): void => {
    const input = document.createElement('input');
    input.className = 'min-w-0 flex-1 bg-transparent px-1 font-mono outline-none';
    input.setAttribute('aria-label', commandAriaLabel);
    input.value = ':';
    statusNode.replaceChildren(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    const close = (): void => {
      input.removeEventListener('keydown', onKeyDown);
      statusNode.replaceChildren(modeNode, keyNode);
      updateStatus();
      editorInstance.focus();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const command = input.value.replace(/^:/, '').trim();
      if (command === 'w' || command === 'write') onSave();
      close();
    };
    input.addEventListener('keydown', onKeyDown);
  };
  const findMatch = (previous: boolean): void => {
    const action = editorInstance.getAction(previous
      ? 'editor.action.previousMatchFindAction'
      : 'editor.action.nextMatchFindAction');
    void action?.run();
  };
  const moveByWords = (direction: 'next' | 'previous', repetitions: number): void => {
    const current = model();
    const start = position();
    if (!current || !start) return;
    let nextPosition: import('monaco-editor/editor').Position = start;
    for (let index = 0; index < repetitions; index += 1) {
      const match: editor.FindMatch | null = direction === 'next'
        ? current.findNextMatch('\\w+', new monaco.Position(nextPosition.lineNumber, nextPosition.column + 1), true, true, null, false)
        : current.findPreviousMatch('\\w+', nextPosition, true, true, null, false);
      if (!match) break;
      nextPosition = match.range.getStartPosition();
    }
    moveTo(nextPosition.lineNumber, nextPosition.column);
  };

  const keySubscription = editorInstance.onKeyDown((event) => {
    const browserEvent = event.browserEvent;
    if (browserEvent.isComposing || browserEvent.defaultPrevented) return;
    const key = browserEvent.key;
    if (key === 'Process' || key === 'Unidentified') return;

    if (mode === 'insert') {
      if (key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      const cursor = position();
      setMode('normal');
      if (cursor) moveTo(cursor.lineNumber, cursor.column - 1);
      return;
    }
    if ((browserEvent.ctrlKey || browserEvent.metaKey) && key.toLowerCase() !== 'r') return;
    if (browserEvent.altKey) return;
    event.preventDefault();
    event.stopPropagation();

    const current = model();
    const cursor = position();
    if (!current || !cursor) return;

    if (/^[0-9]$/.test(key) && (key !== '0' || count > 0)) {
      count = (count * 10) + Number(key);
      updateStatus();
      return;
    }

    if (mode === 'visual' || mode === 'visual-line') {
      if (key === 'Escape') {
        setMode('normal');
        moveTo(cursor.lineNumber, cursor.column);
        return;
      }
      if (key === 'd' || key === 'x') {
        deleteSelection();
        return;
      }
      if (key === 'y') {
        yankSelection();
        return;
      }
    }

    if (pending === 'g') {
      pending = '';
      if (key === 'g') moveTo(pendingCount > 1 ? pendingCount : 1, 1);
      pendingCount = 1;
      updateStatus();
      return;
    }
    if (pending === 'd') {
      pending = '';
      if (key === 'd') {
        const range = currentLineRange(pendingCount);
        if (range) {
          register = current.getValueInRange(range);
          registerLinewise = true;
          const line = range.startLineNumber;
          executeEdit(range, '');
          moveTo(line, 1);
        }
      } else if (key === 'w') {
        const next = current.findNextMatch('\\w+', cursor, true, true, null, false)?.range;
        const range = next
          ? new monaco.Range(cursor.lineNumber, cursor.column, next.startLineNumber, next.startColumn)
          : new monaco.Range(cursor.lineNumber, cursor.column, cursor.lineNumber, current.getLineMaxColumn(cursor.lineNumber));
        register = current.getValueInRange(range);
        registerLinewise = false;
        executeEdit(range, '');
      }
      pendingCount = 1;
      updateStatus();
      return;
    }
    if (pending === 'y') {
      pending = '';
      if (key === 'y') {
        const range = currentLineRange(pendingCount);
        register = range ? current.getValueInRange(range) : '';
        registerLinewise = true;
      }
      pendingCount = 1;
      updateStatus();
      return;
    }

    const hadCount = count > 0;
    const repeat = count || 1;
    count = 0;

    switch (key) {
      case 'i':
        enterInsert(cursor);
        break;
      case 'a':
        enterInsert(new monaco.Position(cursor.lineNumber, Math.min(cursor.column + 1, current.getLineMaxColumn(cursor.lineNumber))));
        break;
      case 'I':
        enterInsert(new monaco.Position(cursor.lineNumber, current.getLineFirstNonWhitespaceColumn(cursor.lineNumber) || 1));
        break;
      case 'A':
        enterInsert(new monaco.Position(cursor.lineNumber, current.getLineMaxColumn(cursor.lineNumber)));
        break;
      case 'o':
        void editorInstance.getAction('editor.action.insertLineAfter')?.run().then(() => enterInsert(position()));
        break;
      case 'O':
        void editorInstance.getAction('editor.action.insertLineBefore')?.run().then(() => enterInsert(position()));
        break;
      case 'h':
      case 'ArrowLeft':
        moveTo(cursor.lineNumber, cursor.column - repeat);
        break;
      case 'l':
      case 'ArrowRight':
        moveTo(cursor.lineNumber, cursor.column + repeat);
        break;
      case 'j':
      case 'ArrowDown':
        moveTo(cursor.lineNumber + repeat, cursor.column);
        break;
      case 'k':
      case 'ArrowUp':
        moveTo(cursor.lineNumber - repeat, cursor.column);
        break;
      case '0':
        moveTo(cursor.lineNumber, 1);
        break;
      case '$':
        moveTo(cursor.lineNumber, normalMaxColumn(cursor.lineNumber));
        break;
      case '^':
        moveTo(cursor.lineNumber, current.getLineFirstNonWhitespaceColumn(cursor.lineNumber) || 1);
        break;
      case 'w':
        moveByWords('next', repeat);
        break;
      case 'b':
        moveByWords('previous', repeat);
        break;
      case 'g':
      case 'd':
      case 'y':
        pending = key;
        pendingCount = repeat;
        updateStatus();
        break;
      case 'G':
        moveTo(hadCount ? repeat : current.getLineCount(), 1);
        break;
      case 'x': {
        const range = new monaco.Range(
          cursor.lineNumber,
          cursor.column,
          cursor.lineNumber,
          Math.min(cursor.column + repeat, current.getLineMaxColumn(cursor.lineNumber)),
        );
        register = current.getValueInRange(range);
        registerLinewise = false;
        executeEdit(range, '');
        break;
      }
      case 'v':
        visualAnchor = cursor;
        setMode('visual');
        visualAnchor = cursor;
        moveTo(cursor.lineNumber, cursor.column + 1);
        break;
      case 'V':
        visualAnchor = cursor;
        setMode('visual-line');
        visualAnchor = cursor;
        moveTo(cursor.lineNumber, cursor.column);
        break;
      case 'p':
      case 'P':
        if (!register) break;
        for (let index = 0; index < repeat; index += 1) {
          if (registerLinewise) {
            const targetLine = key === 'p' ? Math.min(cursor.lineNumber + 1, current.getLineCount() + 1) : cursor.lineNumber;
            const target = targetLine > current.getLineCount()
              ? current.getValueLength()
              : current.getOffsetAt({ lineNumber: targetLine, column: 1 });
            const insert = target === current.getValueLength() && target > 0 ? `\n${register.replace(/\n$/, '')}` : register;
            const point = current.getPositionAt(target);
            executeEdit(new monaco.Range(point.lineNumber, point.column, point.lineNumber, point.column), insert);
          } else {
            const column = key === 'p' ? Math.min(cursor.column + 1, current.getLineMaxColumn(cursor.lineNumber)) : cursor.column;
            executeEdit(new monaco.Range(cursor.lineNumber, column, cursor.lineNumber, column), register);
          }
        }
        break;
      case 'u':
        void current.undo();
        break;
      case 'r':
        if (browserEvent.ctrlKey || browserEvent.metaKey) void current.redo();
        break;
      case '/':
        void editorInstance.getAction('actions.find')?.run();
        break;
      case 'n':
        findMatch(false);
        break;
      case 'N':
        findMatch(true);
        break;
      case ':':
        openCommand();
        break;
      case 'Escape':
        pending = '';
        updateStatus();
        break;
      default:
        pending = '';
        updateStatus();
    }
  });

  setMode('normal');
  editorInstance.focus();

  return {
    dispose() {
      keySubscription.dispose();
      editorInstance.updateOptions({
        cursorBlinking: originalCursorBlinking,
        cursorStyle: originalCursorStyle,
      });
      statusNode.replaceChildren();
    },
    mode: () => mode,
  };
};
