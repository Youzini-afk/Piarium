import { subscribeRuntimeEndpointWillChange } from '@piarium/application-client';
import { MonacoLanguageBridge } from './language-bridge';
import type { FileEditorModelRegistry } from './model-registry';
import type { MonacoRuntime } from './runtime';

let active: MonacoLanguageBridge | null = null;
let boundModels: FileEditorModelRegistry | null = null;
let boundMonaco: MonacoRuntime | null = null;

const reset = (): void => {
  active?.dispose();
  active = null;
  boundModels = null;
  boundMonaco = null;
};

subscribeRuntimeEndpointWillChange(reset);

export const getMonacoLanguageBridge = (
  monaco: MonacoRuntime,
  models: FileEditorModelRegistry,
): MonacoLanguageBridge => {
  if (active && boundMonaco === monaco && boundModels === models) return active;
  reset();
  boundMonaco = monaco;
  boundModels = models;
  active = new MonacoLanguageBridge({ monaco, modelRegistry: models });
  return active;
};
