import type { editor, languages } from 'monaco-editor/editor';

import type {
  LanguageServicesAPI,
  PiariumLanguageDiagnostic,
} from '@/lib/api/types';
import { getDocumentRegistry } from '@/lib/documents/session';
import type { DocumentIdentity, DocumentRecord } from '@/lib/documents/types';
import {
  getLanguageDiagnosticsForResource,
  subscribeLanguageDiagnostics,
} from '@/lib/language-services/diagnostics-registry';
import {
  languageIdsFromResourceId,
} from '@/lib/language-services/language-id';
import {
  acquireLanguageDocument,
  getBoundLanguageServices,
  notifyLanguageDocumentChange,
  notifyLanguageDocumentSave,
  releaseLanguageDocument,
} from '@/lib/language-services/session';
import type { FileEditorModelRegistry } from './model-registry';
import type { MonacoRuntime } from './runtime';

type LanguageEntry = {
  identity: DocumentIdentity;
  languageId: string;
  monacoLanguageId: string;
  lastDocumentVersion: number;
  lastBaseRevision: string | null;
  model: editor.ITextModel;
  owners: Set<string>;
  wasSaving: boolean;
  unsubscribeDocument: () => void;
};

type ProviderEntry = {
  count: number;
  disposables: Array<{ dispose(): void }>;
};

type MonacoLanguageBridgeOptions = {
  acquireDocument?: (identity: DocumentIdentity) => void;
  diagnosticsFor?: (identity: DocumentIdentity) => readonly PiariumLanguageDiagnostic[];
  getLanguage?: () => LanguageServicesAPI | null;
  modelRegistry: FileEditorModelRegistry;
  monaco: MonacoRuntime;
  notifyDocumentChange?: (identity: DocumentIdentity) => void;
  notifyDocumentSave?: (identity: DocumentIdentity) => void;
  releaseDocument?: (identity: DocumentIdentity) => void;
  subscribeDiagnostics?: (listener: () => void) => () => void;
  subscribeDocument?: (identity: DocumentIdentity, listener: (record: DocumentRecord) => void) => () => void;
};

const identityKey = (identity: DocumentIdentity): string => `${identity.workspaceId}\0${identity.resourceId}`;

export class MonacoLanguageBridge {
  private readonly acquireDocument: (identity: DocumentIdentity) => void;
  private readonly diagnosticsFor: (identity: DocumentIdentity) => readonly PiariumLanguageDiagnostic[];
  private readonly getLanguage: () => LanguageServicesAPI | null;
  private readonly modelRegistry: FileEditorModelRegistry;
  private readonly monaco: MonacoRuntime;
  private readonly notifyDocumentChange: (identity: DocumentIdentity) => void;
  private readonly notifyDocumentSave: (identity: DocumentIdentity) => void;
  private readonly releaseDocument: (identity: DocumentIdentity) => void;
  private readonly subscribeDocument: NonNullable<MonacoLanguageBridgeOptions['subscribeDocument']>;
  private readonly entriesByModel = new Map<editor.ITextModel, LanguageEntry>();
  private readonly owners = new Map<string, LanguageEntry>();
  private readonly providers = new Map<string, ProviderEntry>();
  private readonly unsubscribeDiagnostics: () => void;
  private disposed = false;

  constructor(options: MonacoLanguageBridgeOptions) {
    this.monaco = options.monaco;
    this.modelRegistry = options.modelRegistry;
    this.acquireDocument = options.acquireDocument ?? acquireLanguageDocument;
    this.releaseDocument = options.releaseDocument ?? releaseLanguageDocument;
    this.notifyDocumentChange = options.notifyDocumentChange ?? notifyLanguageDocumentChange;
    this.notifyDocumentSave = options.notifyDocumentSave ?? notifyLanguageDocumentSave;
    this.getLanguage = options.getLanguage ?? getBoundLanguageServices;
    this.diagnosticsFor = options.diagnosticsFor ?? ((identity) => (
      getLanguageDiagnosticsForResource(identity.workspaceId, identity.resourceId)
    ));
    this.subscribeDocument = options.subscribeDocument ?? ((identity, listener) => (
      getDocumentRegistry().subscribe(identity, listener)
    ));
    this.unsubscribeDiagnostics = (options.subscribeDiagnostics ?? subscribeLanguageDiagnostics)(
      () => this.refreshAllMarkers(),
    );
  }

  acquire(model: editor.ITextModel, identity: DocumentIdentity, ownerId: string): void {
    if (this.disposed) throw new Error('Monaco language bridge is disposed.');
    const previous = this.owners.get(ownerId);
    if (previous?.model === model && identityKey(previous.identity) === identityKey(identity)) return;
    if (previous) this.release(ownerId);

    let entry = this.entriesByModel.get(model);
    if (!entry) {
      const { hostLanguageId: languageId, monacoLanguageId } = languageIdsFromResourceId(
        identity.resourceId,
        this.monaco.languages.getLanguages(),
      );
      const record = this.modelRegistry.getRecordForModel(model);
      const created: LanguageEntry = {
        identity,
        languageId,
        monacoLanguageId,
        lastDocumentVersion: record?.localEditRevision ?? 0,
        lastBaseRevision: record?.baseRevision ?? null,
        model,
        owners: new Set(),
        wasSaving: record?.saving ?? false,
        unsubscribeDocument: () => undefined,
      };
      created.unsubscribeDocument = this.subscribeDocument(identity, (next) => {
        const documentChanged = next.localEditRevision !== created.lastDocumentVersion;
        const documentSaved = created.wasSaving && !next.saving && next.baseRevision !== created.lastBaseRevision;
        created.lastDocumentVersion = next.localEditRevision;
        created.lastBaseRevision = next.baseRevision;
        created.wasSaving = next.saving;
        if (documentChanged) this.notifyDocumentChange(next.identity);
        if (documentSaved) this.notifyDocumentSave(next.identity);
      });
      entry = created;
      this.entriesByModel.set(model, entry);
      if (languageId !== 'plaintext') {
        this.ensureProviders(monacoLanguageId);
        this.monaco.editor.setModelLanguage(model, monacoLanguageId);
        this.acquireDocument(identity);
      }
      this.refreshMarkers(entry);
    }
    entry.owners.add(ownerId);
    this.owners.set(ownerId, entry);
  }

  release(ownerId: string): void {
    const entry = this.owners.get(ownerId);
    if (!entry) return;
    this.owners.delete(ownerId);
    entry.owners.delete(ownerId);
    if (entry.owners.size > 0) return;
    this.entriesByModel.delete(entry.model);
    entry.unsubscribeDocument();
    this.monaco.editor.setModelMarkers(entry.model, 'piarium-language', []);
    if (entry.languageId !== 'plaintext') {
      this.releaseDocument(entry.identity);
      this.releaseProviders(entry.monacoLanguageId);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeDiagnostics();
    for (const ownerId of [...this.owners.keys()]) this.release(ownerId);
    for (const provider of this.providers.values()) {
      for (const disposable of provider.disposables) disposable.dispose();
    }
    this.providers.clear();
  }

  private ensureProviders(monacoLanguageId: string): void {
    const existing = this.providers.get(monacoLanguageId);
    if (existing) {
      existing.count += 1;
      return;
    }
    const completion = this.monaco.languages.registerCompletionItemProvider(monacoLanguageId, {
      provideCompletionItems: async (model, position, _context, token) => {
        const entry = this.entriesByModel.get(model);
        const language = this.getLanguage();
        const record = this.modelRegistry.getRecordForModel(model);
        if (!entry || !language || !record || token.isCancellationRequested) return { suggestions: [] };
        const capturedVersion = record.localEditRevision;
        const result = await language.completion({
          resource: entry.identity,
          languageId: entry.languageId,
          documentVersion: capturedVersion,
          position: { line: position.lineNumber - 1, character: position.column - 1 },
        });
        const latest = this.modelRegistry.getRecordForModel(model);
        if (
          token.isCancellationRequested
          || result.status !== 'ready'
          || result.documentVersion !== capturedVersion
          || latest?.localEditRevision !== capturedVersion
        ) return { suggestions: [] };
        const word = model.getWordUntilPosition(position);
        const range = new this.monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn,
        );
        return {
          suggestions: result.value.map((item): languages.CompletionItem => ({
            label: item.label,
            insertText: item.insertText ?? item.label,
            kind: this.monaco.languages.CompletionItemKind.Text,
            range,
            ...(item.detail ? { detail: item.detail } : {}),
          })),
        };
      },
    });
    const hover = this.monaco.languages.registerHoverProvider(monacoLanguageId, {
      provideHover: async (model, position, token) => {
        const entry = this.entriesByModel.get(model);
        const language = this.getLanguage();
        const record = this.modelRegistry.getRecordForModel(model);
        if (!entry || !language || !record || token.isCancellationRequested) return null;
        const capturedVersion = record.localEditRevision;
        const result = await language.hover({
          resource: entry.identity,
          languageId: entry.languageId,
          documentVersion: capturedVersion,
          position: { line: position.lineNumber - 1, character: position.column - 1 },
        });
        const latest = this.modelRegistry.getRecordForModel(model);
        if (
          token.isCancellationRequested
          || result.status !== 'ready'
          || !result.value
          || result.documentVersion !== capturedVersion
          || latest?.localEditRevision !== capturedVersion
        ) return null;
        return { contents: [{ value: result.value }] };
      },
    });
    this.providers.set(monacoLanguageId, {
      count: 1,
      disposables: [completion, hover],
    });
  }

  private releaseProviders(languageId: string): void {
    const provider = this.providers.get(languageId);
    if (!provider) return;
    provider.count -= 1;
    if (provider.count > 0) return;
    this.providers.delete(languageId);
    for (const disposable of provider.disposables) disposable.dispose();
  }

  private refreshAllMarkers(): void {
    for (const entry of this.entriesByModel.values()) this.refreshMarkers(entry);
  }

  private refreshMarkers(entry: LanguageEntry): void {
    const diagnostics = this.diagnosticsFor(entry.identity);
    const markers = diagnostics.map((item): editor.IMarkerData => {
      const range = entry.model.validateRange({
        startLineNumber: item.range.start.line + 1,
        startColumn: item.range.start.character + 1,
        endLineNumber: item.range.end.line + 1,
        endColumn: item.range.end.character + 1,
      });
      return {
        message: item.message,
        severity: item.severity === 'error'
          ? this.monaco.MarkerSeverity.Error
          : item.severity === 'warning'
            ? this.monaco.MarkerSeverity.Warning
            : item.severity === 'hint'
              ? this.monaco.MarkerSeverity.Hint
              : this.monaco.MarkerSeverity.Info,
        startLineNumber: range.startLineNumber,
        startColumn: range.startColumn,
        endLineNumber: range.endLineNumber,
        endColumn: range.endColumn,
      };
    });
    this.monaco.editor.setModelMarkers(entry.model, 'piarium-language', markers);
  }
}
