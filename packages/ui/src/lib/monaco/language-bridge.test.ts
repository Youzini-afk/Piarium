import { describe, expect, test, vi } from 'vitest';
import type { editor, languages } from 'monaco-editor/editor';

import type { LanguageServicesAPI, PiariumLanguageDiagnostic } from '@/lib/api/types';
import type { DocumentIdentity, DocumentRecord } from '@/lib/documents/types';
import { MonacoLanguageBridge } from './language-bridge';
import type { FileEditorModelRegistry } from './model-registry';
import type { MonacoRuntime } from './runtime';

const identity: DocumentIdentity = {
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  resourceId: 'src/file.ts',
};

const record = (): DocumentRecord => ({
  identity,
  documentInstanceId: 'document-one',
  connectionGeneration: 1,
  status: 'ready',
  dirty: true,
  saving: false,
  baseContent: '',
  buffer: 'doc',
  baseRevision: 'disk-one',
  localEditRevision: 3,
  encoding: 'utf-8',
  bom: false,
  lineEnding: 'lf',
  byteLength: 3,
  saveOperationId: null,
  saveCapturedEditRevision: null,
  conflict: null,
  errorMessage: null,
  recoveryJournalId: null,
  recoveryJournalRevision: null,
  lastOrigin: null,
  lastChanges: null,
  externalSource: null,
});

describe('MonacoLanguageBridge', () => {
  test('projects markers and baseline providers while rejecting stale feature completion', async () => {
    let current = record();
    let completionProvider: languages.CompletionItemProvider | undefined;
    let hoverProvider: languages.HoverProvider | undefined;
    let documentListener: ((record: DocumentRecord) => void) | undefined;
    let diagnosticsListener: (() => void) | undefined;
    const markers: editor.IMarkerData[][] = [];
    const providerDispose = vi.fn();
    const model = {
      getWordUntilPosition: () => ({ word: 'doc', startColumn: 1, endColumn: 4 }),
      validateRange: (range: unknown) => range,
    } as unknown as editor.ITextModel;
    const monaco = {
      MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
      Range: class {
        constructor(
          readonly startLineNumber: number,
          readonly startColumn: number,
          readonly endLineNumber: number,
          readonly endColumn: number,
        ) {}
      },
      editor: {
        setModelLanguage: vi.fn(),
        setModelMarkers: (_model: editor.ITextModel, _owner: string, next: editor.IMarkerData[]) => markers.push(next),
      },
      languages: {
        CompletionItemKind: { Text: 18 },
        getLanguages: () => [],
        register: () => ({ dispose: providerDispose }),
        registerCompletionItemProvider: (_languageId: string, provider: languages.CompletionItemProvider) => {
          completionProvider = provider;
          return { dispose: providerDispose };
        },
        registerHoverProvider: (_languageId: string, provider: languages.HoverProvider) => {
          hoverProvider = provider;
          return { dispose: providerDispose };
        },
      },
    } as unknown as MonacoRuntime;
    const diagnostic: PiariumLanguageDiagnostic = {
      resource: identity,
      documentVersion: 3,
      severity: 'warning',
      message: 'Check this value',
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 3 },
      },
    };
    const completion = vi.fn(async () => ({
      status: 'ready' as const,
      documentVersion: 3,
      value: [{ label: 'document', insertText: 'document', detail: 'global' }],
    }));
    const hover = vi.fn(async () => ({
      status: 'ready' as const,
      documentVersion: 3,
      value: '`Document`',
    }));
    const language = { completion, hover } as unknown as LanguageServicesAPI;
    const acquireDocument = vi.fn();
    const releaseDocument = vi.fn();
    const notifyDocumentChange = vi.fn();
    const notifyDocumentSave = vi.fn();
    const bridge = new MonacoLanguageBridge({
      monaco,
      modelRegistry: {
        getRecordForModel: () => current,
      } as unknown as FileEditorModelRegistry,
      acquireDocument,
      releaseDocument,
      notifyDocumentChange,
      notifyDocumentSave,
      getLanguage: () => language,
      diagnosticsFor: () => [diagnostic],
      subscribeDiagnostics: (listener) => {
        diagnosticsListener = listener;
        return () => { diagnosticsListener = undefined; };
      },
      subscribeDocument: (_resource, listener) => {
        documentListener = listener;
        return () => { documentListener = undefined; };
      },
    });

    bridge.acquire(model, identity, 'view:one');
    expect(acquireDocument).toHaveBeenCalledWith(identity);
    expect(markers.at(-1)?.[0]).toMatchObject({
      message: 'Check this value',
      severity: 4,
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 4,
    });
    if (!completionProvider?.provideCompletionItems || !hoverProvider?.provideHover) {
      throw new Error('expected Monaco providers');
    }
    const token = { isCancellationRequested: false } as never;
    const completionResult = await completionProvider.provideCompletionItems(
      model,
      { lineNumber: 1, column: 4 } as never,
      {} as languages.CompletionContext,
      token,
    );
    expect(completionResult?.suggestions[0]).toMatchObject({
      label: 'document',
      insertText: 'document',
      range: { startColumn: 1, endColumn: 4 },
    });
    expect(await hoverProvider.provideHover(model, { lineNumber: 1, column: 2 } as never, token)).toEqual({
      contents: [{ value: '`Document`' }],
    });

    current = { ...current, localEditRevision: 4 };
    expect((await completionProvider.provideCompletionItems(
      model,
      { lineNumber: 1, column: 4 } as never,
      {} as languages.CompletionContext,
      token,
    ))?.suggestions).toEqual([]);
    documentListener?.(current);
    expect(notifyDocumentChange).toHaveBeenCalledWith(identity);
    current = { ...current, saving: true };
    documentListener?.(current);
    current = { ...current, saving: false, baseRevision: 'disk-two' };
    documentListener?.(current);
    expect(notifyDocumentSave).toHaveBeenCalledWith(identity);
    diagnosticsListener?.();

    bridge.release('view:one');
    expect(releaseDocument).toHaveBeenCalledWith(identity);
    expect(markers.at(-1)).toEqual([]);
    expect(providerDispose).toHaveBeenCalledTimes(2);
    bridge.dispose();
  });
});
