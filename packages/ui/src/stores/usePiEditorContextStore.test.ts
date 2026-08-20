import { describe, expect, test } from 'bun:test';
import { normalizePiActiveEditorFile, usePiEditorContextStore } from './usePiEditorContextStore';

describe('Pi editor context store', () => {
  test('normalizes the VS Code active editor payload without persisting it', () => {
    expect(normalizePiActiveEditorFile({
      fileName: 'example.ts',
      filePath: 'D:/work/example.ts',
      fileSize: 42,
      relativePath: 'example.ts',
      selection: { endLine: 4, startLine: 2, text: 'const value = 1;' },
    })).toEqual({
      fileName: 'example.ts',
      filePath: 'D:/work/example.ts',
      fileSize: 42,
      relativePath: 'example.ts',
      selection: { endLine: 4, startLine: 2, text: 'const value = 1;' },
      dirty: false,
    });
    expect(normalizePiActiveEditorFile({ fileName: 'missing-path.ts' })).toBeNull();
  });

  test('treats an invalid or empty selection as a whole-file suggestion', () => {
    expect(normalizePiActiveEditorFile({
      fileName: 'example.ts',
      filePath: 'D:/work/example.ts',
      fileSize: null,
      relativePath: 'example.ts',
      selection: { endLine: 1, startLine: 1, text: '' },
    })?.selection).toBeNull();
  });

  test('deduplicates equal updates and clears on null', () => {
    const file = normalizePiActiveEditorFile({
      fileName: 'example.ts',
      filePath: 'D:/work/example.ts',
      fileSize: 42,
      relativePath: 'example.ts',
      selection: null,
    });
    usePiEditorContextStore.setState({ activeEditorFile: null });
    usePiEditorContextStore.getState().setActiveEditorFile(file);
    const first = usePiEditorContextStore.getState().activeEditorFile;
    usePiEditorContextStore.getState().setActiveEditorFile(file ? { ...file } : null);
    expect(usePiEditorContextStore.getState().activeEditorFile).toBe(first);
    usePiEditorContextStore.getState().setActiveEditorFile(null);
    expect(usePiEditorContextStore.getState().activeEditorFile).toBeNull();
  });
});
