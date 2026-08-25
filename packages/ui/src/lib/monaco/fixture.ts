import type { Theme } from '@/types/theme';
import { markMonacoPerformance } from './performance';
import { loadMonacoRuntime } from './runtime';
import { registerPiariumMonacoTheme } from './theme';

export type MonacoSmokeFixture = {
  dispose(): void;
  getLineChangeCount(): number | null;
  whenDiffReady: Promise<void>;
};

export type MonacoEditorPerformanceEvidence = {
  characters: number;
  cold: {
    editToPaintMs: number;
    firstPaintMs: number;
    modelReadyMs: number;
    runtimeReadyMs: number;
  };
  invariants: {
    createdModelCount: number;
    disposedModelCount: number;
    remainingFixtureModelCount: number;
    reusedModelForWarmView: boolean;
  };
  lines: number;
  warm: {
    editToPaintMs: number;
    firstPaintMs: number;
  };
};

const REPRESENTATIVE_LARGE_FILE_LINES = 50_000;

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
  const resources: Array<{ dispose(): void }> = [];
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    const failures: unknown[] = [];
    for (const resource of [...resources].reverse()) {
      try {
        resource.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    container.replaceChildren();
    if (failures.length > 0) throw new AggregateError(failures, 'Failed to dispose Monaco smoke resources');
  };
  try {
    const original = monaco.editor.createModel(
      'export const value = 1;\n',
      'plaintext',
      monaco.Uri.parse('piarium-fixture://phase-8/original'),
    );
    resources.push(original);
    const modified = monaco.editor.createModel(
      'export const value = 2;\n',
      'plaintext',
      monaco.Uri.parse('piarium-fixture://phase-8/modified'),
    );
    resources.push(modified);
    const diffEditor = monaco.editor.createDiffEditor(container, {
      automaticLayout: true,
      minimap: { enabled: false },
      readOnly: true,
      renderSideBySide: true,
      theme: themeName,
    });
    resources.push(diffEditor);
    diffEditor.setModel({ original, modified });
    markMonacoPerformance('editor.model.ready');

    let ready = diffEditor.getLineChanges() !== null;
    let resolveReady: (() => void) | undefined;
    const whenDiffReady = ready
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          resolveReady = resolve;
        });
    const diffSubscription = diffEditor.onDidUpdateDiff(() => {
      if (ready) return;
      ready = true;
      resolveReady?.();
    });
    resources.push(diffSubscription);
    await Promise.all([
      diffEditor.getOriginalEditor().renderAsync(),
      diffEditor.getModifiedEditor().renderAsync(),
    ]);
    markMonacoPerformance('editor.first.paint');
    return {
      dispose,
      getLineChangeCount: () => diffEditor.getLineChanges()?.length ?? null,
      whenDiffReady,
    };
  } catch (error) {
    try {
      dispose();
    } catch (disposeError) {
      throw new AggregateError([error, disposeError], 'Monaco smoke setup and cleanup both failed');
    }
    throw error;
  }
};

export const measureMonacoEditorPerformance = async (
  container: HTMLElement,
  theme: Theme,
): Promise<MonacoEditorPerformanceEvidence> => {
  const source = createRepresentativeLargeFile();
  const runtimeStartedAt = performance.now();
  const monaco = await loadMonacoRuntime();
  const runtimeReadyMs = performance.now() - runtimeStartedAt;
  const themeName = registerPiariumMonacoTheme(monaco, theme);
  const baselineModels = new Set(monaco.editor.getModels());
  const modelUri = monaco.Uri.parse('piarium-fixture://phase-8/large-file');
  let disposedModelCount = 0;
  let remainingFixtureModelCount = 0;
  const modelStartedAt = performance.now();
  const model = monaco.editor.createModel(
    source,
    'plaintext',
    modelUri,
  );
  const createdModelCount = monaco.editor.getModels().filter((candidate) => !baselineModels.has(candidate)).length;
  const modelReadyMs = performance.now() - modelStartedAt;
  let coldFirstPaintMs = Number.NaN;
  let coldEditToPaintMs = Number.NaN;
  let warmFirstPaintMs = Number.NaN;
  let warmEditToPaintMs = Number.NaN;
  let reusedModelForWarmView = false;
  try {
    const coldPaintStartedAt = performance.now();
    const coldEditor = monaco.editor.create(container, {
      automaticLayout: true,
      minimap: { enabled: false },
      model,
      theme: themeName,
    });
    try {
      await coldEditor.renderAsync();
      coldFirstPaintMs = performance.now() - coldPaintStartedAt;
      const coldEditStartedAt = performance.now();
      coldEditor.executeEdits('piarium.phase-8.large-file.cold', [{
        range: new monaco.Range(1, 1, 1, 1),
        text: '// cold edit\n',
      }]);
      await coldEditor.renderAsync();
      coldEditToPaintMs = performance.now() - coldEditStartedAt;
    } finally {
      coldEditor.dispose();
      container.replaceChildren();
    }

    const warmPaintStartedAt = performance.now();
    const warmEditor = monaco.editor.create(container, {
      automaticLayout: true,
      minimap: { enabled: false },
      model,
      theme: themeName,
    });
    reusedModelForWarmView = warmEditor.getModel() === model;
    try {
      await warmEditor.renderAsync();
      warmFirstPaintMs = performance.now() - warmPaintStartedAt;
      const warmEditStartedAt = performance.now();
      warmEditor.executeEdits('piarium.phase-8.large-file.warm', [{
        range: new monaco.Range(1, 1, 1, 1),
        text: '// warm edit\n',
      }]);
      await warmEditor.renderAsync();
      warmEditToPaintMs = performance.now() - warmEditStartedAt;
    } finally {
      warmEditor.dispose();
      container.replaceChildren();
    }
  } finally {
    model.dispose();
    remainingFixtureModelCount = monaco.editor.getModels().filter((candidate) => !baselineModels.has(candidate)).length;
    disposedModelCount = model.isDisposed() && monaco.editor.getModel(modelUri) === null ? 1 : 0;
    container.replaceChildren();
  }

  return {
    characters: source.length,
    cold: {
      editToPaintMs: coldEditToPaintMs,
      firstPaintMs: coldFirstPaintMs,
      modelReadyMs,
      runtimeReadyMs,
    },
    invariants: {
      createdModelCount,
      disposedModelCount,
      remainingFixtureModelCount,
      reusedModelForWarmView,
    },
    lines: REPRESENTATIVE_LARGE_FILE_LINES,
    warm: {
      editToPaintMs: warmEditToPaintMs,
      firstPaintMs: warmFirstPaintMs,
    },
  };
};
