import type { editor, IPosition, IRange } from 'monaco-editor/editor';

import type {
  LanguageServicesAPI,
  PiariumLanguageDiagnostic,
  PiariumLanguageFeatureRequest,
  PiariumResourceReference,
} from '@/lib/api/types';
import { getDocumentRegistry } from '@/lib/documents/session';
import type { DocumentIdentity, DocumentRecord } from '@/lib/documents/types';
import {
  getLanguageDiagnosticsForResource,
  subscribeLanguageDiagnostics,
} from '@/lib/language-services/diagnostics-registry';
import { languageIdsFromResourceId } from '@/lib/language-services/language-id';
import {
  getLanguageProviderStatus,
  subscribeLanguageProviderStatus,
} from '@/lib/language-services/provider-status-registry';
import {
  acquireLanguageDocument,
  getBoundLanguageServices,
  notifyLanguageDocumentChange,
  notifyLanguageDocumentSave,
  releaseLanguageDocument,
} from '@/lib/language-services/session';
import { openExternalUrl } from '@/lib/url';
import { openWorkbenchEditor } from '@/lib/workbench/editors/session';
import {
  fromMonacoPosition,
  fromMonacoRange,
  markerOwner,
  parseMonacoResourceUri,
  PIARIUM_SEMANTIC_TOKENS_LEGEND,
  toMonacoColorInformation,
  toMonacoColorPresentation,
  toMonacoCompletionItem,
  toMonacoDocumentHighlight,
  toMonacoDocumentLink,
  toMonacoDocumentSymbol,
  toMonacoFoldingRange,
  toMonacoHover,
  toMonacoInlayHint,
  toMonacoLocation,
  toMonacoLocationLink,
  toMonacoMarker,
  toMonacoSelectionRanges,
  toMonacoSemanticTokens,
  toMonacoSignatureHelp,
  toMonacoTextEdit,
  type MonacoResolvableCompletionItem,
  type MonacoResolvableInlayHint,
  type MonacoResolvableLink,
  type PiariumResolvableContext,
} from './language-converters';
import type { FileEditorModelRegistry } from './model-registry';
import type { MonacoRuntime } from './runtime';
import { createMonacoNavigationViewState } from './view-state';

type LanguageEntry = {
  identity: DocumentIdentity;
  languageId: string;
  monacoLanguageId: string;
  lastDocumentVersion: number;
  lastBaseRevision: string | null;
  markerOwners: Set<string>;
  model: editor.ITextModel;
  owners: Set<string>;
  wasSaving: boolean;
  unsubscribeDocument: () => void;
};

type ProviderEntry = {
  configurationKey: string;
  count: number;
  disposables: Array<{ dispose(): void }>;
};

type MonacoLanguageBridgeOptions = {
  acquireDocument?: (identity: DocumentIdentity, languageId?: string) => void;
  diagnosticsFor?: (identity: DocumentIdentity) => readonly PiariumLanguageDiagnostic[];
  getLanguage?: () => LanguageServicesAPI | null;
  modelRegistry: FileEditorModelRegistry;
  monaco: MonacoRuntime;
  notifyDocumentChange?: (identity: DocumentIdentity) => void;
  notifyDocumentSave?: (identity: DocumentIdentity) => void;
  releaseDocument?: (identity: DocumentIdentity) => void;
  subscribeDiagnostics?: (listener: () => void) => () => void;
  subscribeDocument?: (identity: DocumentIdentity, listener: (record: DocumentRecord) => void) => () => void;
  subscribeProviderStatus?: (listener: () => void) => () => void;
};

type FeatureContext = {
  entry: LanguageEntry;
  language: LanguageServicesAPI;
  record: DocumentRecord;
  version: number;
};

const identityKey = (identity: DocumentIdentity): string => `${identity.workspaceId}\0${identity.resourceId}`;

const hasRangeShape = (value: IRange | IPosition): value is IRange => 'startLineNumber' in value;

const navigationRange = (selection: IRange | IPosition | undefined): IRange | undefined => {
  if (!selection) return undefined;
  if (hasRangeShape(selection)) return selection;
  return {
    startLineNumber: selection.lineNumber,
    startColumn: selection.column,
    endLineNumber: selection.lineNumber,
    endColumn: selection.column,
  };
};

const unique = (values: readonly string[]): string[] => [...new Set(values)].sort();

export class MonacoLanguageBridge {
  private readonly acquireDocument: (identity: DocumentIdentity, languageId?: string) => void;
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
  private readonly globalDisposables: Array<{ dispose(): void }>;
  private readonly unsubscribeDiagnostics: () => void;
  private readonly unsubscribeProviderStatus: () => void;
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
    this.unsubscribeProviderStatus = (options.subscribeProviderStatus ?? subscribeLanguageProviderStatus)(
      () => this.refreshProviderConfigurations(),
    );
    const openResource = (resource: PiariumResourceReference, selection?: IRange | IPosition): boolean => {
      const range = navigationRange(selection);
      openWorkbenchEditor(resource.workspaceId, resource.resourceId, undefined, range ? {
        viewState: createMonacoNavigationViewState(range),
      } : undefined);
      return true;
    };
    this.globalDisposables = [
      this.monaco.editor.registerEditorOpener({
        openCodeEditor: (_source, uri, selection) => {
          const resource = parseMonacoResourceUri(uri);
          return resource ? openResource(resource, selection) : false;
        },
      }),
      this.monaco.editor.registerLinkOpener({
        open: async (uri) => {
          const resource = parseMonacoResourceUri(uri);
          if (resource) return openResource(resource);
          if (uri.scheme !== 'http' && uri.scheme !== 'https') return false;
          return openExternalUrl(uri.toString());
        },
      }),
    ];
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
        markerOwners: new Set(),
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
        this.monaco.editor.setModelLanguage(model, monacoLanguageId);
        this.acquireDocument(identity, languageId);
        this.ensureProviders(monacoLanguageId);
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
    this.clearMarkers(entry);
    if (entry.languageId !== 'plaintext') {
      this.releaseDocument(entry.identity);
      this.releaseProviders(entry.monacoLanguageId);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeDiagnostics();
    this.unsubscribeProviderStatus();
    for (const ownerId of [...this.owners.keys()]) this.release(ownerId);
    for (const provider of this.providers.values()) {
      for (const disposable of provider.disposables) disposable.dispose();
    }
    for (const disposable of this.globalDisposables) disposable.dispose();
    this.providers.clear();
  }

  private contextFor(model: editor.ITextModel, token: { isCancellationRequested: boolean }): FeatureContext | null {
    if (token.isCancellationRequested) return null;
    const entry = this.entriesByModel.get(model);
    const language = this.getLanguage();
    const record = this.modelRegistry.getRecordForModel(model);
    if (!entry || !language || !record) return null;
    return { entry, language, record, version: record.localEditRevision };
  }

  private contextFromResolvable(context: PiariumResolvableContext | undefined): FeatureContext | null {
    if (!context) return null;
    for (const entry of this.entriesByModel.values()) {
      if (identityKey(entry.identity) !== identityKey(context.resource)) continue;
      const record = this.modelRegistry.getRecordForModel(entry.model);
      const language = this.getLanguage();
      if (!record || !language || record.localEditRevision !== context.documentVersion) return null;
      return { entry, language, record, version: context.documentVersion };
    }
    return null;
  }

  private request(context: FeatureContext, extra: Partial<PiariumLanguageFeatureRequest> = {}): PiariumLanguageFeatureRequest {
    return {
      resource: context.entry.identity,
      languageId: context.entry.languageId,
      documentVersion: context.version,
      ...extra,
    };
  }

  private accepts(
    context: FeatureContext,
    token: { isCancellationRequested: boolean },
    documentVersion: number,
  ): boolean {
    if (token.isCancellationRequested || documentVersion !== context.version) return false;
    return this.modelRegistry.getRecordForModel(context.entry.model)?.localEditRevision === context.version;
  }

  private triggerConfiguration(monacoLanguageId: string): {
    completion: string[];
    signature: string[];
    signatureRetrigger: string[];
    onType: string[];
  } {
    const completion: string[] = [];
    const signature: string[] = [];
    const signatureRetrigger: string[] = [];
    const onType: string[] = [];
    for (const entry of this.entriesByModel.values()) {
      if (entry.monacoLanguageId !== monacoLanguageId) continue;
      const status = getLanguageProviderStatus(entry.identity.workspaceId, entry.languageId);
      if (status.status !== 'ready' && status.status !== 'degraded') continue;
      completion.push(...(status.features?.completionTriggerCharacters ?? []));
      signature.push(...(status.features?.signatureHelpTriggerCharacters ?? []));
      signatureRetrigger.push(...(status.features?.signatureHelpRetriggerCharacters ?? []));
      onType.push(...(status.features?.onTypeFormattingTriggerCharacters ?? []));
    }
    return {
      completion: unique(completion),
      signature: unique(signature),
      signatureRetrigger: unique(signatureRetrigger),
      onType: unique(onType),
    };
  }

  private providerConfigurationKey(monacoLanguageId: string): string {
    return JSON.stringify(this.triggerConfiguration(monacoLanguageId));
  }

  private ensureProviders(monacoLanguageId: string): void {
    const existing = this.providers.get(monacoLanguageId);
    if (existing) {
      existing.count += 1;
      this.rebuildProviderIfNeeded(monacoLanguageId, existing);
      return;
    }
    this.providers.set(monacoLanguageId, {
      configurationKey: this.providerConfigurationKey(monacoLanguageId),
      count: 1,
      disposables: this.createProviderDisposables(monacoLanguageId),
    });
  }

  private createProviderDisposables(monacoLanguageId: string): Array<{ dispose(): void }> {
    const triggers = this.triggerConfiguration(monacoLanguageId);
    const completion = this.monaco.languages.registerCompletionItemProvider(monacoLanguageId, {
      ...(triggers.completion.length ? { triggerCharacters: triggers.completion } : {}),
      provideCompletionItems: async (model, position, completionContext, token) => {
        const context = this.contextFor(model, token);
        if (!context) return { suggestions: [] };
        const triggerKind = completionContext.triggerKind === this.monaco.languages.CompletionTriggerKind.TriggerCharacter
          ? 'triggerCharacter'
          : completionContext.triggerKind === this.monaco.languages.CompletionTriggerKind.TriggerForIncompleteCompletions
            ? 'incomplete'
            : 'invoked';
        const result = await context.language.completion(this.request(context, {
          position: fromMonacoPosition(position),
          triggerKind,
          ...(completionContext.triggerCharacter ? { triggerCharacter: completionContext.triggerCharacter } : {}),
        }));
        if (result.status !== 'ready' || !this.accepts(context, token, result.documentVersion)) {
          return { suggestions: [] };
        }
        const word = model.getWordUntilPosition(position);
        const fallbackRange = {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: word.endColumn,
        };
        const resolvableContext: PiariumResolvableContext = {
          resource: context.entry.identity,
          languageId: context.entry.languageId,
          documentVersion: context.version,
        };
        return {
          suggestions: result.value.map((item) => ({
            ...toMonacoCompletionItem(this.monaco, item, fallbackRange),
            __piariumContext: resolvableContext,
          })),
        };
      },
      resolveCompletionItem: async (item: MonacoResolvableCompletionItem, token) => {
        if (!item.__piariumResolveToken || token.isCancellationRequested) return item;
        const context = this.contextFromResolvable(item.__piariumContext);
        if (!context) return item;
        const result = await context.language.completionResolve(this.request(context, {
          resolveToken: item.__piariumResolveToken,
        }));
        if (result.status !== 'ready' || !this.accepts(context, token, result.documentVersion)) return item;
        const fallbackRange = 'insert' in item.range ? item.range.replace : item.range;
        return {
          ...toMonacoCompletionItem(this.monaco, result.value, fallbackRange),
          __piariumContext: item.__piariumContext,
        };
      },
    });
    const hover = this.monaco.languages.registerHoverProvider(monacoLanguageId, {
      provideHover: async (model, position, token) => {
        const context = this.contextFor(model, token);
        if (!context) return null;
        const result = await context.language.hover(this.request(context, { position: fromMonacoPosition(position) }));
        return result.status === 'ready' && this.accepts(context, token, result.documentVersion)
          ? toMonacoHover(result.value)
          : null;
      },
    });
    const signature = this.monaco.languages.registerSignatureHelpProvider(monacoLanguageId, {
      ...(triggers.signature.length ? { signatureHelpTriggerCharacters: triggers.signature } : {}),
      ...(triggers.signatureRetrigger.length ? { signatureHelpRetriggerCharacters: triggers.signatureRetrigger } : {}),
      provideSignatureHelp: async (model, position, token, signatureContext) => {
        const context = this.contextFor(model, token);
        if (!context) return null;
        const triggerKind = signatureContext.triggerKind === this.monaco.languages.SignatureHelpTriggerKind.TriggerCharacter
          ? 'triggerCharacter'
          : signatureContext.triggerKind === this.monaco.languages.SignatureHelpTriggerKind.ContentChange
            ? 'incomplete'
            : 'invoked';
        const result = await context.language.signatureHelp(this.request(context, {
          position: fromMonacoPosition(position),
          triggerKind,
          ...(signatureContext.triggerCharacter ? { triggerCharacter: signatureContext.triggerCharacter } : {}),
        }));
        return result.status === 'ready' && this.accepts(context, token, result.documentVersion)
          ? toMonacoSignatureHelp(result.value)
          : null;
      },
    });
    const definition = this.monaco.languages.registerDefinitionProvider(monacoLanguageId, {
      provideDefinition: async (model, position, token) => {
        const context = this.contextFor(model, token);
        if (!context) return [];
        const result = await context.language.definition(this.request(context, { position: fromMonacoPosition(position) }));
        return result.status === 'ready' && this.accepts(context, token, result.documentVersion)
          ? result.value.map((value) => toMonacoLocationLink(this.monaco, value))
          : [];
      },
    });
    const references = this.monaco.languages.registerReferenceProvider(monacoLanguageId, {
      provideReferences: async (model, position, _referenceContext, token) => {
        const context = this.contextFor(model, token);
        if (!context) return [];
        const result = await context.language.references(this.request(context, { position: fromMonacoPosition(position) }));
        return result.status === 'ready' && this.accepts(context, token, result.documentVersion)
          ? result.value.map((value) => toMonacoLocation(this.monaco, value))
          : [];
      },
    });
    const symbols = this.monaco.languages.registerDocumentSymbolProvider(monacoLanguageId, {
      displayName: 'Piarium',
      provideDocumentSymbols: async (model, token) => {
        const context = this.contextFor(model, token);
        if (!context) return [];
        const result = await context.language.documentSymbols(this.request(context));
        return result.status === 'ready' && this.accepts(context, token, result.documentVersion)
          ? result.value.map((value) => toMonacoDocumentSymbol(this.monaco, value))
          : [];
      },
    });
    const highlights = this.monaco.languages.registerDocumentHighlightProvider(monacoLanguageId, {
      provideDocumentHighlights: async (model, position, token) => {
        const context = this.contextFor(model, token);
        if (!context) return [];
        const result = await context.language.documentHighlights(this.request(context, { position: fromMonacoPosition(position) }));
        return result.status === 'ready' && this.accepts(context, token, result.documentVersion)
          ? result.value.map((value) => toMonacoDocumentHighlight(this.monaco, value))
          : [];
      },
    });
    const formatting = this.monaco.languages.registerDocumentFormattingEditProvider(monacoLanguageId, {
      displayName: 'Piarium',
      provideDocumentFormattingEdits: async (model, options, token) => {
        const context = this.contextFor(model, token);
        if (!context) return [];
        const result = await context.language.documentFormatting(this.request(context, { formatting: options }));
        return result.status === 'ready' && this.accepts(context, token, result.documentVersion)
          ? result.value.map(toMonacoTextEdit)
          : [];
      },
    });
    const rangeFormatting = this.monaco.languages.registerDocumentRangeFormattingEditProvider(monacoLanguageId, {
      displayName: 'Piarium',
      provideDocumentRangeFormattingEdits: async (model, range, options, token) => {
        const context = this.contextFor(model, token);
        if (!context) return [];
        const result = await context.language.documentRangeFormatting(this.request(context, {
          range: fromMonacoRange(range),
          formatting: options,
        }));
        return result.status === 'ready' && this.accepts(context, token, result.documentVersion)
          ? result.value.map(toMonacoTextEdit)
          : [];
      },
    });
    const onType = triggers.onType.length > 0
      ? this.monaco.languages.registerOnTypeFormattingEditProvider(monacoLanguageId, {
          autoFormatTriggerCharacters: triggers.onType,
          provideOnTypeFormattingEdits: async (model, position, ch, options, token) => {
            const context = this.contextFor(model, token);
            if (!context) return [];
            const result = await context.language.onTypeFormatting(this.request(context, {
              position: fromMonacoPosition(position),
              triggerCharacter: ch,
              formatting: options,
            }));
            return result.status === 'ready' && this.accepts(context, token, result.documentVersion)
              ? result.value.map(toMonacoTextEdit)
              : [];
          },
        })
      : null;
    const folding = this.monaco.languages.registerFoldingRangeProvider(monacoLanguageId, {
      provideFoldingRanges: async (model, _foldingContext, token) => {
        const context = this.contextFor(model, token);
        if (!context) return [];
        const result = await context.language.foldingRanges(this.request(context));
        return result.status === 'ready' && this.accepts(context, token, result.documentVersion)
          ? result.value.map((value) => toMonacoFoldingRange(this.monaco, value))
          : [];
      },
    });
    const selection = this.monaco.languages.registerSelectionRangeProvider(monacoLanguageId, {
      provideSelectionRanges: async (model, positions, token) => {
        const context = this.contextFor(model, token);
        if (!context) return [];
        const result = await context.language.selectionRanges(this.request(context, {
          positions: positions.map(fromMonacoPosition),
        }));
        return result.status === 'ready' && this.accepts(context, token, result.documentVersion)
          ? result.value.map(toMonacoSelectionRanges)
          : [];
      },
    });
    const semantic = this.monaco.languages.registerDocumentSemanticTokensProvider(monacoLanguageId, {
      getLegend: () => PIARIUM_SEMANTIC_TOKENS_LEGEND,
      provideDocumentSemanticTokens: async (model, lastResultId, token) => {
        const context = this.contextFor(model, token);
        if (!context) return null;
        const result = await context.language.semanticTokens(this.request(context, {
          ...(lastResultId ? { previousResultId: lastResultId } : {}),
        }));
        return result.status === 'ready' && this.accepts(context, token, result.documentVersion)
          ? toMonacoSemanticTokens(result.value)
          : null;
      },
      releaseDocumentSemanticTokens: () => undefined,
    });
    const inlay = this.monaco.languages.registerInlayHintsProvider(monacoLanguageId, {
      displayName: 'Piarium',
      provideInlayHints: async (model, range, token) => {
        const context = this.contextFor(model, token);
        if (!context) return { hints: [], dispose() {} };
        const result = await context.language.inlayHints(this.request(context, { range: fromMonacoRange(range) }));
        if (result.status !== 'ready' || !this.accepts(context, token, result.documentVersion)) {
          return { hints: [], dispose() {} };
        }
        const resolvableContext: PiariumResolvableContext = {
          resource: context.entry.identity,
          languageId: context.entry.languageId,
          documentVersion: context.version,
        };
        return {
          hints: result.value.map((value) => ({
            ...toMonacoInlayHint(this.monaco, value),
            __piariumContext: resolvableContext,
          })),
          dispose() {},
        };
      },
      resolveInlayHint: async (hint: MonacoResolvableInlayHint, token) => {
        if (!hint.__piariumResolveToken || token.isCancellationRequested) return hint;
        const context = this.contextFromResolvable(hint.__piariumContext);
        if (!context) return hint;
        const result = await context.language.inlayHintResolve(this.request(context, {
          resolveToken: hint.__piariumResolveToken,
        }));
        return result.status === 'ready' && this.accepts(context, token, result.documentVersion)
          ? { ...toMonacoInlayHint(this.monaco, result.value), __piariumContext: hint.__piariumContext }
          : hint;
      },
    });
    const links = this.monaco.languages.registerLinkProvider(monacoLanguageId, {
      provideLinks: async (model, token) => {
        const context = this.contextFor(model, token);
        if (!context) return { links: [] };
        const result = await context.language.documentLinks(this.request(context));
        if (result.status !== 'ready' || !this.accepts(context, token, result.documentVersion)) return { links: [] };
        const resolvableContext: PiariumResolvableContext = {
          resource: context.entry.identity,
          languageId: context.entry.languageId,
          documentVersion: context.version,
        };
        return {
          links: result.value.map((value) => ({
            ...toMonacoDocumentLink(this.monaco, value),
            __piariumContext: resolvableContext,
          })),
        };
      },
      resolveLink: async (link: MonacoResolvableLink, token) => {
        if (!link.__piariumResolveToken || token.isCancellationRequested) return link;
        const context = this.contextFromResolvable(link.__piariumContext);
        if (!context) return link;
        const result = await context.language.documentLinkResolve(this.request(context, {
          resolveToken: link.__piariumResolveToken,
        }));
        return result.status === 'ready' && this.accepts(context, token, result.documentVersion)
          ? { ...toMonacoDocumentLink(this.monaco, result.value), __piariumContext: link.__piariumContext }
          : link;
      },
    });
    const colors = this.monaco.languages.registerColorProvider(monacoLanguageId, {
      provideDocumentColors: async (model, token) => {
        const context = this.contextFor(model, token);
        if (!context) return [];
        const result = await context.language.documentColors(this.request(context));
        return result.status === 'ready' && this.accepts(context, token, result.documentVersion)
          ? result.value.map(toMonacoColorInformation)
          : [];
      },
      provideColorPresentations: async (model, colorInfo, token) => {
        const context = this.contextFor(model, token);
        if (!context) return [];
        const result = await context.language.colorPresentations(this.request(context, {
          range: fromMonacoRange(colorInfo.range),
          color: colorInfo.color,
        }));
        return result.status === 'ready' && this.accepts(context, token, result.documentVersion)
          ? result.value.map(toMonacoColorPresentation)
          : [];
      },
    });
    return [
      completion,
      hover,
      signature,
      definition,
      references,
      symbols,
      highlights,
      formatting,
      rangeFormatting,
      ...(onType ? [onType] : []),
      folding,
      selection,
      semantic,
      inlay,
      links,
      colors,
    ];
  }

  private releaseProviders(languageId: string): void {
    const provider = this.providers.get(languageId);
    if (!provider) return;
    provider.count -= 1;
    if (provider.count > 0) {
      this.rebuildProviderIfNeeded(languageId, provider);
      return;
    }
    this.providers.delete(languageId);
    for (const disposable of provider.disposables) disposable.dispose();
  }

  private refreshProviderConfigurations(): void {
    for (const [languageId, provider] of this.providers) {
      this.rebuildProviderIfNeeded(languageId, provider);
    }
  }

  private rebuildProviderIfNeeded(languageId: string, provider: ProviderEntry): void {
    const configurationKey = this.providerConfigurationKey(languageId);
    if (provider.configurationKey === configurationKey) return;
    for (const disposable of provider.disposables) disposable.dispose();
    provider.configurationKey = configurationKey;
    provider.disposables = this.createProviderDisposables(languageId);
  }

  private refreshAllMarkers(): void {
    for (const entry of this.entriesByModel.values()) this.refreshMarkers(entry);
  }

  private clearMarkers(entry: LanguageEntry): void {
    for (const owner of entry.markerOwners) {
      this.monaco.editor.setModelMarkers(entry.model, owner, []);
    }
    entry.markerOwners.clear();
  }

  private refreshMarkers(entry: LanguageEntry): void {
    const byOwner = new Map<string, PiariumLanguageDiagnostic[]>();
    for (const diagnostic of this.diagnosticsFor(entry.identity)) {
      const owner = markerOwner(diagnostic.providerId ?? 'legacy', diagnostic.generation ?? 0);
      const values = byOwner.get(owner) ?? [];
      values.push(diagnostic);
      byOwner.set(owner, values);
    }
    for (const owner of entry.markerOwners) {
      if (!byOwner.has(owner)) this.monaco.editor.setModelMarkers(entry.model, owner, []);
    }
    for (const [owner, diagnostics] of byOwner) {
      this.monaco.editor.setModelMarkers(
        entry.model,
        owner,
        diagnostics.map((diagnostic) => toMonacoMarker(this.monaco, diagnostic)),
      );
    }
    entry.markerOwners = new Set(byOwner.keys());
  }
}
