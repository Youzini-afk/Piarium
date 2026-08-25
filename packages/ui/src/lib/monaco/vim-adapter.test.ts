import { afterEach, describe, expect, test, vi } from 'vitest';
import type { editor, IKeyboardEvent } from 'monaco-editor/editor';

import type { MonacoRuntime } from './runtime';
import { createPiariumMonacoVimAdapter } from './vim-adapter';

class FakeElement {
  className = '';
  textContent = '';
  value = '';
  children: FakeElement[] = [];
  private readonly listeners = new Map<string, Set<(event: KeyboardEvent) => void>>();

  replaceChildren(...children: FakeElement[]): void {
    this.children = children;
  }

  setAttribute(): void {}
  focus(): void {}
  setSelectionRange(): void {}

  addEventListener(type: string, listener: (event: KeyboardEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: KeyboardEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: KeyboardEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakePosition {
  constructor(readonly lineNumber: number, readonly column: number) {}
}

class FakeRange {
  constructor(
    readonly startLineNumber: number,
    readonly startColumn: number,
    readonly endLineNumber: number,
    readonly endColumn: number,
  ) {}

  getStartPosition(): FakePosition {
    return new FakePosition(this.startLineNumber, this.startColumn);
  }
}

class FakeSelection extends FakeRange {
  isEmpty(): boolean {
    return this.startLineNumber === this.endLineNumber && this.startColumn === this.endColumn;
  }
}

class FakeModel {
  value = 'one\ntwo';
  undo = vi.fn();
  redo = vi.fn();

  getLineCount(): number { return this.value.split('\n').length; }
  getLineContent(line: number): string { return this.value.split('\n')[line - 1] ?? ''; }
  getLineMaxColumn(line: number): number { return this.getLineContent(line).length + 1; }
  getLineFirstNonWhitespaceColumn(): number { return 1; }
  getValueLength(): number { return this.value.length; }

  getOffsetAt(position: { lineNumber: number; column: number }): number {
    const lines = this.value.split('\n');
    let offset = 0;
    for (let index = 0; index < position.lineNumber - 1; index += 1) offset += (lines[index]?.length ?? 0) + 1;
    return offset + position.column - 1;
  }

  getPositionAt(offset: number): FakePosition {
    const before = this.value.slice(0, offset).split('\n');
    return new FakePosition(before.length, (before.at(-1)?.length ?? 0) + 1);
  }

  getValueInRange(range: FakeRange): string {
    return this.value.slice(
      this.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn }),
      this.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn }),
    );
  }

  findNextMatch(): null { return null; }
  findPreviousMatch(): null { return null; }
}

class FakeEditor {
  readonly model = new FakeModel();
  readonly find = vi.fn(async () => undefined);
  readonly focus = vi.fn();
  private cursor = new FakePosition(1, 1);
  private selection = new FakeSelection(1, 1, 1, 1);
  private readonly keyListeners = new Set<(event: IKeyboardEvent) => void>();

  getModel(): editor.ITextModel { return this.model as unknown as editor.ITextModel; }
  getPosition(): import('monaco-editor/editor').Position { return this.cursor as unknown as import('monaco-editor/editor').Position; }
  getSelection(): import('monaco-editor/editor').Selection { return this.selection as unknown as import('monaco-editor/editor').Selection; }
  setPosition(position: FakePosition): void {
    this.cursor = position;
    this.selection = new FakeSelection(position.lineNumber, position.column, position.lineNumber, position.column);
  }
  setSelection(selection: FakeSelection): void {
    this.selection = selection;
    this.cursor = new FakePosition(selection.endLineNumber, selection.endColumn);
  }
  revealPositionInCenterIfOutsideViewport(): void {}
  pushUndoStop(): void {}
  getAction(id: string): { run(): Promise<void> } | null {
    return id === 'actions.find' ? { run: this.find } : { run: async () => undefined };
  }
  executeEdits(_source: string, edits: Array<{ range: FakeRange; text: string }>): boolean {
    for (const edit of [...edits].reverse()) {
      const from = this.model.getOffsetAt({ lineNumber: edit.range.startLineNumber, column: edit.range.startColumn });
      const to = this.model.getOffsetAt({ lineNumber: edit.range.endLineNumber, column: edit.range.endColumn });
      this.model.value = `${this.model.value.slice(0, from)}${edit.text}${this.model.value.slice(to)}`;
      this.setPosition(this.model.getPositionAt(from + edit.text.length));
    }
    return true;
  }
  onKeyDown(listener: (event: IKeyboardEvent) => void): { dispose(): void } {
    this.keyListeners.add(listener);
    return { dispose: () => this.keyListeners.delete(listener) };
  }
  simulate(key: string, modifiers: Partial<KeyboardEvent> = {}): void {
    const browserEvent = {
      key,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      defaultPrevented: false,
      isComposing: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      ...modifiers,
    } as unknown as KeyboardEvent;
    const event = {
      browserEvent,
      preventDefault: () => browserEvent.preventDefault(),
      stopPropagation: () => browserEvent.stopPropagation(),
    } as IKeyboardEvent;
    for (const listener of this.keyListeners) listener(event);
  }
}

const originalDocument = globalThis.document;

afterEach(() => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
});

describe('Piarium Monaco Vim adapter', () => {
  test('supports modal input, destructive commands, search, save, and clean disposal', async () => {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: () => new FakeElement() },
    });
    const editorInstance = new FakeEditor();
    const statusNode = new FakeElement();
    const save = vi.fn();
    const monaco = {
      Position: FakePosition,
      Range: FakeRange,
      Selection: FakeSelection,
    } as unknown as MonacoRuntime;
    const adapter = createPiariumMonacoVimAdapter({
      commandAriaLabel: 'Vim command',
      editor: editorInstance as unknown as editor.IStandaloneCodeEditor,
      monaco,
      onSave: save,
      statusNode: statusNode as unknown as HTMLElement,
    });

    expect(adapter.mode()).toBe('normal');
    editorInstance.simulate('i');
    expect(adapter.mode()).toBe('insert');
    editorInstance.simulate('Escape');
    expect(adapter.mode()).toBe('normal');

    editorInstance.simulate('l');
    editorInstance.simulate('x');
    expect(editorInstance.model.value).toBe('oe\ntwo');
    editorInstance.simulate('0');
    editorInstance.simulate('d');
    editorInstance.simulate('d');
    expect(editorInstance.model.value).toBe('two');

    editorInstance.simulate('/');
    expect(editorInstance.find).toHaveBeenCalledTimes(1);
    editorInstance.simulate(':');
    const input = statusNode.children[0];
    input.value = ':w';
    input.dispatch('keydown', {
      key: 'Enter',
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent);
    expect(save).toHaveBeenCalledTimes(1);

    adapter.dispose();
    expect(statusNode.children).toEqual([]);
    editorInstance.simulate('i');
    expect(adapter.mode()).toBe('normal');
    const reenabled = createPiariumMonacoVimAdapter({
      commandAriaLabel: 'Vim command',
      editor: editorInstance as unknown as editor.IStandaloneCodeEditor,
      monaco,
      onSave: save,
      statusNode: statusNode as unknown as HTMLElement,
    });
    editorInstance.simulate('i');
    expect(reenabled.mode()).toBe('insert');
    reenabled.dispose();
    await Promise.resolve();
  });
});
