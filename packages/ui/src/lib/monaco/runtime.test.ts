import { describe, expect, test, vi } from 'vitest';

import {
  createMonacoRuntimeController,
  MonacoRuntimeError,
  type MonacoRuntime,
} from './runtime';

const fakeRuntime = { editor: {} } as MonacoRuntime;
const fakeWorker = (): Worker => ({ terminate: vi.fn() }) as unknown as Worker;

describe('Monaco runtime controller', () => {
  test('loads the editor and feature graph once and creates only editor workers', async () => {
    const environmentHost = { Worker: class {} };
    const loadEditor = vi.fn(async () => fakeRuntime);
    const loadEditorFeatures = vi.fn(async () => undefined);
    const loadIconFont = vi.fn(async () => undefined);
    const loadLanguageDefinitions = vi.fn(async () => undefined);
    const loadEditorWorkerUrl = vi.fn(async () => '/assets/editor.worker.js');
    const createWorker = vi.fn(() => fakeWorker());
    const controller = createMonacoRuntimeController({
      createWorker,
      environmentHost,
      loadEditor,
      loadEditorFeatures,
      loadIconFont,
      loadLanguageDefinitions,
      loadEditorWorkerUrl,
    });

    const [first, second] = await Promise.all([controller.load(), controller.load()]);
    expect(first).toBe(fakeRuntime);
    expect(second).toBe(fakeRuntime);
    expect(loadEditor).toHaveBeenCalledTimes(1);
    expect(loadEditorFeatures).toHaveBeenCalledTimes(1);
    expect(loadIconFont).toHaveBeenCalledTimes(1);
    expect(loadLanguageDefinitions).toHaveBeenCalledTimes(1);
    expect(loadEditorWorkerUrl).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().status).toBe('ready');

    const environment = (environmentHost as typeof environmentHost & {
      MonacoEnvironment: { getWorker(moduleId: string, label: string): Worker };
    }).MonacoEnvironment;
    expect(environment.getWorker('module', 'editorWorkerService')).toBeDefined();
    expect(createWorker).toHaveBeenCalledWith('/assets/editor.worker.js');
    expect(controller.getSnapshot().workerCreatedCount).toBe(1);
  });

  test('rejects semantic worker labels instead of silently starting a second language service', async () => {
    const environmentHost = { Worker: class {} };
    const controller = createMonacoRuntimeController({
      createWorker: () => fakeWorker(),
      environmentHost,
      loadEditor: async () => fakeRuntime,
      loadEditorFeatures: async () => undefined,
      loadLanguageDefinitions: async () => undefined,
      loadEditorWorkerUrl: async () => '/assets/editor.worker.js',
    });
    await controller.load();

    const environment = (environmentHost as typeof environmentHost & {
      MonacoEnvironment: { getWorker(moduleId: string, label: string): Worker };
    }).MonacoEnvironment;
    expect(() => environment.getWorker('module', 'typescript')).toThrowError(MonacoRuntimeError);
    expect(controller.getSnapshot().unexpectedWorkerRequestCount).toBe(1);
  });

  test('preserves an environment owned by another runtime and reports a retryable failure', async () => {
    const existing = { getWorker: () => fakeWorker() };
    const environmentHost = {
      MonacoEnvironment: existing,
      Worker: class {},
    };
    const controller = createMonacoRuntimeController({
      createWorker: () => fakeWorker(),
      environmentHost,
      loadEditor: async () => fakeRuntime,
      loadEditorFeatures: async () => undefined,
      loadLanguageDefinitions: async () => undefined,
      loadEditorWorkerUrl: async () => '/assets/editor.worker.js',
    });

    await expect(controller.load()).rejects.toMatchObject({ reason: 'environment-owned' });
    expect((environmentHost as typeof environmentHost & { MonacoEnvironment: unknown }).MonacoEnvironment).toBe(existing);
    expect(controller.getSnapshot()).toMatchObject({
      status: 'failed',
      errorMessage: 'MonacoEnvironment is already owned by another runtime.',
    });
  });

  test('does not publish a ready editor while the Codicon font is unavailable', async () => {
    const controller = createMonacoRuntimeController({
      createWorker: () => fakeWorker(),
      environmentHost: { Worker: class {} },
      loadEditor: async () => fakeRuntime,
      loadEditorFeatures: async () => undefined,
      loadIconFont: async () => {
        throw new MonacoRuntimeError('load-failed', 'Monaco Codicon font is unavailable.');
      },
      loadLanguageDefinitions: async () => undefined,
      loadEditorWorkerUrl: async () => '/assets/editor.worker.js',
    });

    await expect(controller.load()).rejects.toMatchObject({ reason: 'load-failed' });
    expect(controller.getSnapshot()).toMatchObject({
      status: 'failed',
      errorMessage: 'Monaco Codicon font is unavailable.',
    });
  });

  test('distinguishes a Surface without Worker support', async () => {
    const controller = createMonacoRuntimeController({
      createWorker: () => fakeWorker(),
      environmentHost: {},
      loadEditor: async () => fakeRuntime,
      loadEditorFeatures: async () => undefined,
      loadLanguageDefinitions: async () => undefined,
      loadEditorWorkerUrl: async () => '/assets/editor.worker.js',
    });

    await expect(controller.load()).rejects.toMatchObject({ reason: 'unsupported' });
    expect(controller.getSnapshot().status).toBe('failed');
  });
});
