import { afterEach, describe, expect, test, vi } from 'vitest';
import type { editor, IDisposable } from 'monaco-editor/editor';

import { DEFAULT_FILE_EDITOR_SETTINGS } from '@/lib/file-editor-settings';
import { getWorkbenchContextKey } from '@/lib/workbench/editors/context-keys';
import {
  executeActiveFileEditorCommand,
  FILE_EDITOR_COMMAND_IDS,
  hasActiveFileEditorCommandTarget,
  registerFileEditorCommandTarget,
  requestFileEditorNavigation,
  resetFileEditorCommandServiceForTests,
} from './editor-command-service';

class FakeDomNode {
  private readonly listeners = new Set<(event: KeyboardEvent) => void>();

  addEventListener(_type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === 'function') this.listeners.add(listener as (event: KeyboardEvent) => void);
  }

  removeEventListener(_type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === 'function') this.listeners.delete(listener as (event: KeyboardEvent) => void);
  }

  emit(event: KeyboardEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

class FakeEditor {
  readonly actions = new Map<string, ReturnType<typeof vi.fn>>();
  readonly domNode = new FakeDomNode();
  readonly options: editor.IEditorOptions = { wordWrap: 'off', minimap: { enabled: false } };
  readonly revealPositionInCenter = vi.fn();
  readonly setPosition = vi.fn();

  getRawOptions(): editor.IEditorOptions { return this.options; }
  getSelection(): null { return null; }
  getModel(): Pick<editor.ITextModel, 'getLanguageId' | 'getLineCount' | 'getLineMaxColumn'> {
    return {
      getLanguageId: () => 'typescript',
      getLineCount: () => 20,
      getLineMaxColumn: () => 80,
    };
  }
  getAction(id: string): editor.IEditorAction {
    const run = this.actions.get(id) ?? vi.fn(async () => undefined);
    this.actions.set(id, run);
    return {
      id,
      label: id,
      alias: id,
      isSupported: () => true,
      run: run as unknown as (args?: unknown) => Promise<void>,
    } as unknown as editor.IEditorAction;
  }
  getDomNode(): HTMLElement { return this.domNode as unknown as HTMLElement; }
  focus(): void {}
  onDidFocusEditorText(): IDisposable { return { dispose() {} }; }
  onDidBlurEditorText(): IDisposable { return { dispose() {} }; }
  onDidChangeCursorSelection(): IDisposable { return { dispose() {} }; }
  onDidChangeModelLanguage(): IDisposable { return { dispose() {} }; }
}

const keyboardEvent = (overrides: Partial<KeyboardEvent> = {}): KeyboardEvent => ({
  altKey: false,
  code: 'KeyH',
  ctrlKey: true,
  defaultPrevented: false,
  isComposing: false,
  key: 'h',
  metaKey: false,
  preventDefault: vi.fn(),
  shiftKey: false,
  stopPropagation: vi.fn(),
  ...overrides,
}) as unknown as KeyboardEvent;

afterEach(() => resetFileEditorCommandServiceForTests());

describe('file editor command service', () => {
  test('projects the active editor into commands and context without owning the model', async () => {
    const editorInstance = new FakeEditor();
    const updateSettings = vi.fn();
    const dispose = registerFileEditorCommandTarget({
      editor: editorInstance as unknown as editor.IStandaloneCodeEditor,
      getSettings: () => ({ ...DEFAULT_FILE_EDITOR_SETTINGS }),
      getShortcutOverrides: () => ({}),
      identity: { workspaceId: 'workspace', resourceId: 'src/main.ts' },
      ownerId: 'view:one',
      updateSettings,
      viewId: 'one',
    });

    expect(hasActiveFileEditorCommandTarget()).toBe(true);
    expect(getWorkbenchContextKey('editorIsOpen')).toBe(true);
    expect(getWorkbenchContextKey('editorLanguageId')).toBe('typescript');

    await executeActiveFileEditorCommand(FILE_EDITOR_COMMAND_IDS.find);
    expect(editorInstance.actions.get('actions.find')).toHaveBeenCalledTimes(1);
    await executeActiveFileEditorCommand(FILE_EDITOR_COMMAND_IDS.toggleWrap);
    expect(updateSettings).toHaveBeenCalledWith({ wordWrap: 'on' });

    dispose();
    expect(hasActiveFileEditorCommandTarget()).toBe(false);
    expect(getWorkbenchContextKey('editorIsOpen')).toBe(false);
  });

  test('does not let a stale disposer remove a replacement with the same owner ID', () => {
    const first = new FakeEditor();
    const second = new FakeEditor();
    const createTarget = (editorInstance: FakeEditor) => ({
      editor: editorInstance as unknown as editor.IStandaloneCodeEditor,
      getSettings: () => ({ ...DEFAULT_FILE_EDITOR_SETTINGS }),
      getShortcutOverrides: () => ({}),
      identity: { workspaceId: 'workspace', resourceId: 'src/main.ts' },
      ownerId: 'view:one',
      updateSettings: vi.fn(),
      viewId: 'one',
    });
    const disposeFirst = registerFileEditorCommandTarget(createTarget(first));
    const disposeSecond = registerFileEditorCommandTarget(createTarget(second));

    disposeFirst();
    expect(hasActiveFileEditorCommandTarget()).toBe(true);
    expect(getWorkbenchContextKey('editorLanguageId')).toBe('typescript');

    disposeSecond();
    expect(hasActiveFileEditorCommandTarget()).toBe(false);
  });

  test('captures Ctrl+H on the owning editor and runs Monaco replace once', async () => {
    const editorInstance = new FakeEditor();
    registerFileEditorCommandTarget({
      editor: editorInstance as unknown as editor.IStandaloneCodeEditor,
      getSettings: () => ({ ...DEFAULT_FILE_EDITOR_SETTINGS }),
      getShortcutOverrides: () => ({}),
      identity: { workspaceId: 'workspace', resourceId: 'src/main.ts' },
      ownerId: 'view:replace',
      updateSettings: vi.fn(),
      viewId: 'replace',
    });
    const event = keyboardEvent();

    editorInstance.domNode.emit(event);
    await vi.waitFor(() => {
      expect(editorInstance.actions.get('editor.action.startFindReplaceAction')).toHaveBeenCalledTimes(1);
    });
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });

  test('routes a shortcut to the editor that received it, not a stale active target', async () => {
    const first = new FakeEditor();
    const second = new FakeEditor();
    const register = (editorInstance: FakeEditor, ownerId: string) => registerFileEditorCommandTarget({
      editor: editorInstance as unknown as editor.IStandaloneCodeEditor,
      getSettings: () => ({ ...DEFAULT_FILE_EDITOR_SETTINGS }),
      getShortcutOverrides: () => ({}),
      identity: { workspaceId: 'workspace', resourceId: `${ownerId}.ts` },
      ownerId,
      updateSettings: vi.fn(),
      viewId: ownerId,
    });
    register(first, 'first');
    register(second, 'second');

    second.domNode.emit(keyboardEvent());
    await vi.waitFor(() => {
      expect(second.actions.get('editor.action.startFindReplaceAction')).toHaveBeenCalledTimes(1);
    });
    expect(first.actions.has('editor.action.startFindReplaceAction')).toBe(false);
  });

  test('reads shortcut overrides at event time', async () => {
    const editorInstance = new FakeEditor();
    registerFileEditorCommandTarget({
      editor: editorInstance as unknown as editor.IStandaloneCodeEditor,
      getSettings: () => ({ ...DEFAULT_FILE_EDITOR_SETTINGS }),
      getShortcutOverrides: () => ({ editor_replace: 'mod+r' }),
      identity: { workspaceId: 'workspace', resourceId: 'override.ts' },
      ownerId: 'override',
      updateSettings: vi.fn(),
      viewId: 'override',
    });

    editorInstance.domNode.emit(keyboardEvent());
    expect(editorInstance.actions.has('editor.action.startFindReplaceAction')).toBe(false);
    editorInstance.domNode.emit(keyboardEvent({ code: 'KeyR', key: 'r' }));
    await vi.waitFor(() => {
      expect(editorInstance.actions.get('editor.action.startFindReplaceAction')).toHaveBeenCalledTimes(1);
    });
  });

  test('delivers a pending search hit to the editor when its target mounts', async () => {
    const identity = { workspaceId: 'workspace', resourceId: 'src/main.ts' };
    expect(requestFileEditorNavigation(identity, 7, 12)).toBe(false);
    const editorInstance = new FakeEditor();

    registerFileEditorCommandTarget({
      editor: editorInstance as unknown as editor.IStandaloneCodeEditor,
      getSettings: () => ({ ...DEFAULT_FILE_EDITOR_SETTINGS }),
      getShortcutOverrides: () => ({}),
      identity,
      ownerId: 'view:navigation',
      updateSettings: vi.fn(),
      viewId: 'navigation',
    });
    await Promise.resolve();

    expect(editorInstance.setPosition).toHaveBeenCalledWith({ lineNumber: 7, column: 12 });
    expect(editorInstance.revealPositionInCenter).toHaveBeenCalledWith({ lineNumber: 7, column: 12 });
  });

  test('keeps pending navigation scoped to the requested view of a split resource', async () => {
    const identity = { workspaceId: 'workspace', resourceId: 'src/shared.ts' };
    const first = new FakeEditor();
    const second = new FakeEditor();
    expect(requestFileEditorNavigation(identity, 9, 3, 'second')).toBe(false);
    const register = (editorInstance: FakeEditor, viewId: string) => registerFileEditorCommandTarget({
      editor: editorInstance as unknown as editor.IStandaloneCodeEditor,
      getSettings: () => ({ ...DEFAULT_FILE_EDITOR_SETTINGS }),
      getShortcutOverrides: () => ({}),
      identity,
      ownerId: `view:${viewId}`,
      updateSettings: vi.fn(),
      viewId,
    });

    register(first, 'first');
    await Promise.resolve();
    expect(first.setPosition).not.toHaveBeenCalled();
    register(second, 'second');
    await Promise.resolve();

    expect(first.setPosition).not.toHaveBeenCalled();
    expect(second.setPosition).toHaveBeenCalledWith({ lineNumber: 9, column: 3 });
  });
});
