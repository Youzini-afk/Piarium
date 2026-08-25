import {
  measureEditorLargeFileBaseline,
  mountMonacoSmokeFixture,
  type EditorLargeFileBaseline,
} from '@/lib/monaco/fixture';
import { getMonacoRuntimeSnapshot } from '@/lib/monaco/runtime';
import { getDefaultTheme } from '@/lib/theme/themes';

type MonacoSmokeState = {
  disposed?: boolean;
  errorMessage?: string;
  largeFileBaseline?: EditorLargeFileBaseline;
  lineChangeCount?: number;
  runtime?: ReturnType<typeof getMonacoRuntimeSnapshot>;
  status: 'loading' | 'ready' | 'failed';
};

declare global {
  interface Window {
    __piariumMonacoSmoke?: MonacoSmokeState;
  }
}

const root = document.querySelector('#monaco-smoke-root');
if (!(root instanceof HTMLElement)) throw new Error('Missing Monaco smoke root.');
root.style.height = '100vh';
root.style.width = '100vw';

window.__piariumMonacoSmoke = { status: 'loading' };
root.dataset.monacoSmokeStatus = 'loading';

const publish = (state: MonacoSmokeState): void => {
  window.__piariumMonacoSmoke = state;
  root.dataset.monacoSmokeStatus = state.status;
  root.dataset.monacoSmokeResult = JSON.stringify(state);
};

const withDeadline = async <T>(promise: Promise<T>, milliseconds: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Monaco diff worker did not become ready.')), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

void (async () => {
  try {
    const fixture = await mountMonacoSmokeFixture(root, getDefaultTheme(true));
    await withDeadline(fixture.whenDiffReady, 20_000);
    const lineChangeCount = fixture.getLineChangeCount();
    if (!Number.isFinite(lineChangeCount) || (lineChangeCount ?? 0) < 1) {
      throw new Error('Monaco diff worker returned no line changes.');
    }
    fixture.dispose();
    const largeFileBaseline = await measureEditorLargeFileBaseline(root, getDefaultTheme(true));
    const measurements = [
      ...Object.values(largeFileBaseline.codeMirror),
      ...Object.values(largeFileBaseline.monaco),
    ];
    if (!measurements.every(Number.isFinite)) {
      throw new Error(`Large-file fixture returned invalid measurements: ${JSON.stringify(largeFileBaseline)}`);
    }
    const runtime = getMonacoRuntimeSnapshot();
    if (runtime.workerCreatedCount < 1 || runtime.unexpectedWorkerRequestCount !== 0) {
      throw new Error(`Unexpected Monaco worker state: ${JSON.stringify(runtime)}`);
    }
    publish({
      disposed: root.childElementCount === 0,
      largeFileBaseline,
      lineChangeCount: lineChangeCount ?? 0,
      runtime,
      status: 'ready',
    });
  } catch (error) {
    publish({
      errorMessage: error instanceof Error ? error.message : String(error),
      runtime: getMonacoRuntimeSnapshot(),
      status: 'failed',
    });
  }
})();
