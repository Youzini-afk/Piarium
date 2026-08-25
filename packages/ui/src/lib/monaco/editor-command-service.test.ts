import { afterEach, describe, expect, test, vi } from 'vitest';
import type { editor, IDisposable, IKeyboardEvent } from 'monaco-editor/editor';

import { DEFAULT_FILE_EDITOR_SETTINGS } from '@/lib/file-editor-settings';
import { getWorkbenchContextKey } from '@/lib/workbench/editors/context-keys';
import {
  executeActiveFileEditorCommand,
  FILE_EDITOR_COMMAND_IDS,
  hasActiveFileEditorCommandTarget,
  registerFileEditorCommandTarget,
  resetFileEditorCommandServiceForTests,
} from './editor-command-service';

class FakeEditor {
  readonly actions = new Map<string, ReturnType<typeof vi.fn>>();
  readonly options: editor.IEditorOptions = { wordWrap: 'off', minimap: { enabled: false } };
  private readonly keyListeners = new Set<(event: IKeyboardEvent) => void>();

  getRawOptions(): editor.IEditorOptions { return this.options; }
  getSelection(): null { return null; }
  getModel(): Pick<editor.ITextModel, 'getLanguageId'> { return { getLanguageId: () => 'typescript' }; }
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
  focus(): void {}
  onDidFocusEditorText(): IDisposable { return { dispose() {} }; }
  onDidBlurEditorText(): IDisposable { return { dispose() {} }; }
  onDidChangeCursorSelection(): IDisposable { return { dispose() {} }; }
  onDidChangeModelLanguage(): IDisposable { return { dispose() {} }; }
  onKeyDown(listener: (event: IKeyboardEvent) => void): IDisposable {
    this.keyListeners.add(listener);
    return { dispose: () => this.keyListeners.delete(listener) };
  }
}

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
});
