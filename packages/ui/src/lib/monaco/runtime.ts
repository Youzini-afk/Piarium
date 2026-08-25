import { markMonacoPerformance } from './performance';

export type MonacoRuntime = typeof import('monaco-editor/editor');

export type MonacoRuntimeFailureReason =
  | 'environment-owned'
  | 'load-failed'
  | 'unexpected-worker-label'
  | 'unsupported';

export class MonacoRuntimeError extends Error {
  readonly reason: MonacoRuntimeFailureReason;

  constructor(reason: MonacoRuntimeFailureReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MonacoRuntimeError';
    this.reason = reason;
  }
}

export type MonacoRuntimeSnapshot = {
  status: 'idle' | 'loading' | 'ready' | 'failed';
  workerCreatedCount: number;
  unexpectedWorkerRequestCount: number;
  errorMessage?: string;
};

type MonacoEnvironment = {
  __piariumOwner?: 'piarium';
  getWorker?(moduleId: string, label: string): Promise<Worker> | Worker;
};

type MonacoEnvironmentHost = {
  MonacoEnvironment?: MonacoEnvironment;
  Worker?: unknown;
};

type MonacoRuntimeDependencies = {
  createWorker(workerUrl: string): Worker;
  environmentHost: MonacoEnvironmentHost;
  loadEditor(): Promise<MonacoRuntime>;
  loadEditorFeatures(): Promise<void>;
  loadEditorWorkerUrl(): Promise<string>;
};

export type MonacoRuntimeController = {
  getSnapshot(): MonacoRuntimeSnapshot;
  load(): Promise<MonacoRuntime>;
  subscribe(listener: () => void): () => void;
};

const isEditorWorkerLabel = (label: string): boolean => (
  label === '' || label === 'editor' || label === 'editorWorkerService'
);

const asErrorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

export const createMonacoRuntimeController = (
  dependencies: MonacoRuntimeDependencies,
): MonacoRuntimeController => {
  let snapshot: MonacoRuntimeSnapshot = {
    status: 'idle',
    workerCreatedCount: 0,
    unexpectedWorkerRequestCount: 0,
  };
  let runtime: MonacoRuntime | undefined;
  let inflight: Promise<MonacoRuntime> | undefined;
  const listeners = new Set<() => void>();

  const publish = (next: MonacoRuntimeSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const installEnvironment = (workerUrl: string): void => {
    const existing = dependencies.environmentHost.MonacoEnvironment;
    if (existing && existing.__piariumOwner !== 'piarium') {
      throw new MonacoRuntimeError(
        'environment-owned',
        'MonacoEnvironment is already owned by another runtime.',
      );
    }

    dependencies.environmentHost.MonacoEnvironment = {
      __piariumOwner: 'piarium',
      getWorker(_moduleId, label) {
        if (!isEditorWorkerLabel(label)) {
          publish({
            ...snapshot,
            unexpectedWorkerRequestCount: snapshot.unexpectedWorkerRequestCount + 1,
          });
          throw new MonacoRuntimeError(
            'unexpected-worker-label',
            `Piarium does not register Monaco's built-in semantic worker: ${label || '<empty>'}`,
          );
        }
        const worker = dependencies.createWorker(workerUrl);
        publish({ ...snapshot, workerCreatedCount: snapshot.workerCreatedCount + 1 });
        markMonacoPerformance('editor.worker.created');
        return worker;
      },
    };
  };

  const load = (): Promise<MonacoRuntime> => {
    if (runtime) return Promise.resolve(runtime);
    if (inflight) return inflight;
    if (typeof dependencies.environmentHost.Worker === 'undefined') {
      const error = new MonacoRuntimeError(
        'unsupported',
        'Monaco requires Web Worker support in this Surface.',
      );
      publish({ ...snapshot, status: 'failed', errorMessage: error.message });
      return Promise.reject(error);
    }

    publish({
      status: 'loading',
      workerCreatedCount: snapshot.workerCreatedCount,
      unexpectedWorkerRequestCount: snapshot.unexpectedWorkerRequestCount,
    });
    markMonacoPerformance('editor.runtime.import.start');

    inflight = (async () => {
      const workerUrl = await dependencies.loadEditorWorkerUrl();
      installEnvironment(workerUrl);
      const [loaded] = await Promise.all([
        dependencies.loadEditor(),
        dependencies.loadEditorFeatures(),
      ]);
      runtime = loaded;
      publish({
        status: 'ready',
        workerCreatedCount: snapshot.workerCreatedCount,
        unexpectedWorkerRequestCount: snapshot.unexpectedWorkerRequestCount,
      });
      markMonacoPerformance('editor.runtime.import.end');
      return loaded;
    })().catch((cause: unknown) => {
      const error = cause instanceof MonacoRuntimeError
        ? cause
        : new MonacoRuntimeError('load-failed', 'Unable to load the Monaco runtime.', { cause });
      publish({
        status: 'failed',
        workerCreatedCount: snapshot.workerCreatedCount,
        unexpectedWorkerRequestCount: snapshot.unexpectedWorkerRequestCount,
        errorMessage: asErrorMessage(error),
      });
      throw error;
    }).finally(() => {
      inflight = undefined;
    });

    return inflight;
  };

  return {
    getSnapshot: () => snapshot,
    load,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

const defaultController = createMonacoRuntimeController({
  createWorker: (workerUrl) => new Worker(workerUrl, {
    name: 'piarium-monaco-editor',
    type: 'module',
  }),
  environmentHost: globalThis as unknown as MonacoEnvironmentHost,
  loadEditor: () => import('monaco-editor/editor'),
  loadEditorFeatures: () => import('monaco-editor/features/register.all').then(() => undefined),
  loadEditorWorkerUrl: () => import('monaco-editor/editor/editor.worker?worker&url')
    .then(({ default: workerUrl }) => workerUrl),
});

export const getMonacoRuntimeSnapshot = (): MonacoRuntimeSnapshot => defaultController.getSnapshot();
export const loadMonacoRuntime = (): Promise<MonacoRuntime> => defaultController.load();
export const subscribeMonacoRuntime = (listener: () => void): (() => void) => (
  defaultController.subscribe(listener)
);
