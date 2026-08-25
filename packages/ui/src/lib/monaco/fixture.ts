import { history } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import type { Theme } from '@/types/theme';
import { markMonacoPerformance } from './performance';
import { loadMonacoRuntime } from './runtime';
import { registerPiariumMonacoTheme } from './theme';

export type MonacoSmokeFixture = {
  dispose(): void;
  getLineChangeCount(): number | null;
  whenDiffReady: Promise<void>;
};

export type EditorLargeFileBaseline = {
  characters: number;
  codeMirror: EditorLargeFileEngineMetrics;
  lines: number;
  monaco: EditorLargeFileEngineMetrics;
};

type EditorLargeFileEngineMetrics = {
  editToPaintMs: number;
  firstPaintMs: number;
  modelReadyMs: number;
};

const REPRESENTATIVE_LARGE_FILE_LINES = 50_000;

const waitForCodeMirrorMeasure = (view: EditorView): Promise<void> => (
  new Promise((resolve) => {
    view.requestMeasure({
      read: () => undefined,
      write: () => resolve(),
    });
  })
);

const createRepresentativeLargeFile = (): string => (
  Array.from(
    { length: REPRESENTATIVE_LARGE_FILE_LINES },
    (_value, index) => `export const value${index} = ${index};`,
  ).join('\n')
);

export const mountMonacoSmokeFixture = async (
  container: HTMLElement,
  theme: Theme,
): Promise<MonacoSmokeFixture> => {
  const monaco = await loadMonacoRuntime();
  const themeName = registerPiariumMonacoTheme(monaco, theme);
  const original = monaco.editor.createModel(
    'export const value = 1;\n',
    'plaintext',
    monaco.Uri.parse('piarium-fixture://phase-1/original'),
  );
  const modified = monaco.editor.createModel(
    'export const value = 2;\n',
    'plaintext',
    monaco.Uri.parse('piarium-fixture://phase-1/modified'),
  );
  const editor = monaco.editor.createDiffEditor(container, {
    automaticLayout: true,
    minimap: { enabled: false },
    readOnly: true,
    renderSideBySide: true,
    theme: themeName,
  });
  editor.setModel({ original, modified });
  markMonacoPerformance('editor.model.ready');

  let ready = editor.getLineChanges() !== null;
  let resolveReady: (() => void) | undefined;
  const whenDiffReady = ready
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
  const diffSubscription = editor.onDidUpdateDiff(() => {
    if (ready) return;
    ready = true;
    resolveReady?.();
  });

  try {
    await Promise.all([
      editor.getOriginalEditor().renderAsync(),
      editor.getModifiedEditor().renderAsync(),
    ]);
  } catch (error) {
    diffSubscription.dispose();
    editor.dispose();
    original.dispose();
    modified.dispose();
    throw error;
  }
  markMonacoPerformance('editor.first.paint');

  return {
    dispose() {
      diffSubscription.dispose();
      editor.dispose();
      original.dispose();
      modified.dispose();
    },
    getLineChangeCount: () => editor.getLineChanges()?.length ?? null,
    whenDiffReady,
  };
};

export const measureEditorLargeFileBaseline = async (
  container: HTMLElement,
  theme: Theme,
): Promise<EditorLargeFileBaseline> => {
  const source = createRepresentativeLargeFile();

  const codeMirrorModelStartedAt = performance.now();
  const codeMirrorState = EditorState.create({
    doc: source,
    extensions: [history()],
  });
  const codeMirrorModelReadyMs = performance.now() - codeMirrorModelStartedAt;
  const codeMirrorPaintStartedAt = performance.now();
  const codeMirrorView = new EditorView({ state: codeMirrorState, parent: container });
  let codeMirrorFirstPaintMs: number;
  let codeMirrorEditToPaintMs: number;
  try {
    await waitForCodeMirrorMeasure(codeMirrorView);
    codeMirrorFirstPaintMs = performance.now() - codeMirrorPaintStartedAt;
    const codeMirrorEditStartedAt = performance.now();
    codeMirrorView.dispatch({ changes: { from: 0, insert: '// edited\n' } });
    await waitForCodeMirrorMeasure(codeMirrorView);
    codeMirrorEditToPaintMs = performance.now() - codeMirrorEditStartedAt;
  } finally {
    codeMirrorView.destroy();
    container.replaceChildren();
  }

  const monaco = await loadMonacoRuntime();
  const themeName = registerPiariumMonacoTheme(monaco, theme);
  const monacoModelStartedAt = performance.now();
  const model = monaco.editor.createModel(
    source,
    'plaintext',
    monaco.Uri.parse('piarium-fixture://phase-1/large-file'),
  );
  const monacoModelReadyMs = performance.now() - monacoModelStartedAt;
  const monacoPaintStartedAt = performance.now();
  const editor = monaco.editor.create(container, {
    automaticLayout: true,
    minimap: { enabled: false },
    model,
    theme: themeName,
  });
  let monacoFirstPaintMs: number;
  let monacoEditToPaintMs: number;
  try {
    await editor.renderAsync();
    monacoFirstPaintMs = performance.now() - monacoPaintStartedAt;
    const monacoEditStartedAt = performance.now();
    editor.executeEdits('piarium.phase-1.large-file', [{
      range: new monaco.Range(1, 1, 1, 1),
      text: '// edited\n',
    }]);
    await editor.renderAsync();
    monacoEditToPaintMs = performance.now() - monacoEditStartedAt;
  } finally {
    editor.dispose();
    model.dispose();
  }

  return {
    characters: source.length,
    codeMirror: {
      editToPaintMs: codeMirrorEditToPaintMs,
      firstPaintMs: codeMirrorFirstPaintMs,
      modelReadyMs: codeMirrorModelReadyMs,
    },
    lines: REPRESENTATIVE_LARGE_FILE_LINES,
    monaco: {
      editToPaintMs: monacoEditToPaintMs,
      firstPaintMs: monacoFirstPaintMs,
      modelReadyMs: monacoModelReadyMs,
    },
  };
};
