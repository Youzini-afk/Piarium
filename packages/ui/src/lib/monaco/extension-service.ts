import type { editor, IDisposable, IRange } from 'monaco-editor/editor';
import {
  PIARIUM_EDITOR_MONACO_SERVICE_ID,
  PIARIUM_EDITOR_MONACO_SERVICE_VERSION,
  type PiariumEditorMonacoFailureResultV1,
  type PiariumEditorMonacoRangeV1,
  type PiariumEditorMonacoServiceV1,
  type PiariumEditorMonacoStateResultV1,
  type PiariumEditorMonacoViewRequestV1,
} from '@piarium/extension-contract';
import type { SurfaceExternalService, SurfaceOwnerIdentity } from '@piarium/extension-surface';

import type { DocumentIdentity } from '@/lib/documents/types';

type MonacoViewRegistration = {
  editor: editor.IStandaloneCodeEditor;
  getDocumentVersion(): number;
  identity: DocumentIdentity;
  kind: 'diff-modified' | 'text';
  providerId: string;
  viewId: string;
};

type LiveMonacoView = MonacoViewRegistration & {
  generation: number;
  listeners: IDisposable[];
};

type OwnedDecorations = {
  decorationIds: string[];
  owner: SurfaceOwnerIdentity;
  sourceId: string;
  viewGeneration: number;
  viewId: string;
};

type MonacoExtensionServiceFailure = PiariumEditorMonacoFailureResultV1;

export type MonacoExtensionInspectorSnapshot = {
  activeViewId: string | null;
  owners: Array<{
    entrypointId: string;
    extensionId: string;
    generation: number;
    realmId: string;
    registrationCount: number;
  }>;
  revision: number;
  views: Array<{
    documentVersion: number;
    focused: boolean;
    generation: number;
    kind: LiveMonacoView['kind'];
    providerId: string;
    resourceId: string;
    viewId: string;
    workspaceId: string;
  }>;
};

const ownerKey = (owner: SurfaceOwnerIdentity): string => (
  `${owner.extensionId}\0${owner.realmId}\0${owner.entrypointId}\0${owner.generation}`
);

const registrationKey = (owner: SurfaceOwnerIdentity, sourceId: string): string => (
  `${ownerKey(owner)}\0${sourceId}`
);

const ownerIdentity = (owner: SurfaceOwnerIdentity): SurfaceOwnerIdentity => ({ ...owner });

const publicRange = (value: IRange): PiariumEditorMonacoRangeV1 => ({
  start: { line: value.startLineNumber, column: value.startColumn },
  end: { line: value.endLineNumber, column: value.endColumn },
});

const monacoRange = (value: PiariumEditorMonacoRangeV1): IRange => ({
  startLineNumber: value.start.line,
  startColumn: value.start.column,
  endLineNumber: value.end.line,
  endColumn: value.end.column,
});

const documentVersion = (view: LiveMonacoView): number => view.getDocumentVersion();

const serviceDescriptor = {
  id: PIARIUM_EDITOR_MONACO_SERVICE_ID,
  version: PIARIUM_EDITOR_MONACO_SERVICE_VERSION,
} as const;

class MonacoExtensionServiceRegistry {
  readonly #decorations = new Map<string, OwnedDecorations>();
  readonly #listeners = new Set<() => void>();
  readonly #owners = new Map<string, SurfaceOwnerIdentity>();
  readonly #viewStateListeners = new Set<() => void>();
  readonly #views = new Map<string, LiveMonacoView>();
  #activeViewId: string | null = null;
  #inspectorDirty = false;
  #nextViewGeneration = 1;
  #viewRevision = 0;
  #snapshot: MonacoExtensionInspectorSnapshot = {
    activeViewId: null,
    owners: [],
    revision: 0,
    views: [],
  };

  getSnapshot = (): MonacoExtensionInspectorSnapshot => {
    if (this.#inspectorDirty) this.#refreshInspectorSnapshot();
    return this.#snapshot;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  subscribeViewState = (listener: () => void): (() => void) => {
    this.#viewStateListeners.add(listener);
    return () => this.#viewStateListeners.delete(listener);
  };

  getViewRevision = (): number => this.#viewRevision;

  getViewStateResult = (): PiariumEditorMonacoStateResultV1 => ({
    state: {
      activeViewId: this.#activeViewId,
      revision: this.#viewRevision,
      views: [...this.#views.values()].map((view) => this.#snapshotView(view)),
    },
    status: 'ready',
  });

  registerView(input: MonacoViewRegistration): () => void {
    const previous = this.#views.get(input.viewId);
    if (previous) this.#removeView(previous);
    const view: LiveMonacoView = {
      ...input,
      generation: this.#nextViewGeneration,
      listeners: [],
    };
    this.#nextViewGeneration += 1;
    view.listeners.push(
      input.editor.onDidFocusEditorWidget(() => {
        this.#activeViewId = input.viewId;
        this.#advanceViewRevision(true);
      }),
      input.editor.onDidChangeCursorSelection(() => this.#advanceViewRevision(false)),
      input.editor.onDidChangeModel(() => this.#advanceViewRevision(true)),
    );
    this.#views.set(input.viewId, view);
    if (!this.#activeViewId) this.#activeViewId = input.viewId;
    this.#advanceViewRevision(true);
    return () => {
      if (this.#views.get(input.viewId) !== view) return;
      this.#removeView(view);
      this.#advanceViewRevision(true);
    };
  }

  externalService(ownerValue: SurfaceOwnerIdentity): SurfaceExternalService<PiariumEditorMonacoServiceV1> {
    const owner = ownerIdentity(ownerValue);
    const key = ownerKey(owner);
    this.#owners.set(key, owner);
    this.#publish();
    let disposed = false;
    const pendingStateWaiters = new Set<() => void>();
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      for (const cancel of [...pendingStateWaiters]) cancel();
      this.#clearOwner(owner);
      this.#owners.delete(key);
      this.#publish();
    };
    const staleOwner = (): PiariumEditorMonacoFailureResultV1 => ({
      reason: 'owner-generation-changed',
      status: 'stale',
    });
    const implementation = {
      getActiveView: () => disposed ? staleOwner() : this.#viewSnapshot(this.#target({})),
      getState: () => disposed ? staleOwner() : this.getViewStateResult(),
      getView: (request: PiariumEditorMonacoViewRequestV1 = {}) => disposed
        ? staleOwner()
        : this.#withView(request, (view) => this.#viewSnapshot(view)),
      focus: (request: PiariumEditorMonacoViewRequestV1 = {}) => disposed ? staleOwner() : this.#withView(request, (view) => {
        const previousRevision = this.#viewRevision;
        this.#activeViewId = view.viewId;
        view.editor.focus();
        if (this.#viewRevision === previousRevision) this.#advanceViewRevision(true);
        return { status: 'ready' as const, view: this.#snapshotView(view) };
      }),
      reveal: (request) => disposed ? staleOwner() : this.#withView(request, (view) => {
        const model = view.editor.getModel();
        if (!model) return { status: 'absent' as const, reason: 'view-unavailable' as const };
        const range = model.validateRange(monacoRange(request.range));
        view.editor.revealRangeInCenter(range);
        return { status: 'ready' as const, view: this.#snapshotView(view) };
      }),
      setSelection: (request) => disposed ? staleOwner() : this.#withView(request, (view) => {
        const model = view.editor.getModel();
        if (!model) return { status: 'absent' as const, reason: 'view-unavailable' as const };
        const range = model.validateRange(monacoRange(request.range));
        const activeChanged = this.#activeViewId !== view.viewId;
        const previousRevision = this.#viewRevision;
        this.#activeViewId = view.viewId;
        view.editor.setSelection(range);
        if (this.#viewRevision === previousRevision && activeChanged) this.#advanceViewRevision(true);
        else if (activeChanged) this.#publish();
        return { status: 'ready' as const, view: this.#snapshotView(view) };
      }),
      executeAction: async (request) => {
        if (disposed) return staleOwner();
        const result = await Promise.resolve(this.#withView(request, async (view) => {
          const action = view.editor.getAction(request.actionId);
          if (!action?.isSupported()) {
            return { status: 'unsupported' as const, reason: 'action-unavailable' as const };
          }
          if (request.args === undefined) await action.run();
          else await action.run(request.args);
          return { status: 'ready' as const, view: this.#snapshotView(view) };
        }));
        return disposed ? staleOwner() : result;
      },
      setDecorations: (request) => disposed ? staleOwner() : this.#withView(request, (view) => {
        const model = view.editor.getModel();
        if (!model) return { status: 'absent' as const, reason: 'view-unavailable' as const };
        const id = registrationKey(owner, request.sourceId);
        const previousRegistration = this.#decorations.get(id);
        if (previousRegistration) this.#clearDecoration(previousRegistration);
        const decorationIds = view.editor.deltaDecorations([], request.decorations.map((decoration) => ({
          range: model.validateRange(monacoRange(decoration.range)),
          options: {
            ...(decoration.className ? { className: decoration.className } : {}),
            ...(decoration.glyphMarginClassName ? { glyphMarginClassName: decoration.glyphMarginClassName } : {}),
            ...(decoration.inlineClassName ? { inlineClassName: decoration.inlineClassName } : {}),
            ...(decoration.isWholeLine !== undefined ? { isWholeLine: decoration.isWholeLine } : {}),
          },
        })));
        this.#decorations.set(id, {
          decorationIds,
          owner,
          sourceId: request.sourceId,
          viewGeneration: view.generation,
          viewId: view.viewId,
        });
        this.#publish();
        return {
          status: 'ready' as const,
          registrationId: request.sourceId,
          view: this.#snapshotView(view),
        };
      }),
      clearDecorations: (request) => {
        if (disposed) return staleOwner();
        const id = registrationKey(owner, request.sourceId);
        const registration = this.#decorations.get(id);
        if (!registration) return { status: 'absent' as const, reason: 'registration-unavailable' as const };
        this.#clearDecoration(registration);
        this.#decorations.delete(id);
        this.#publish();
        return { status: 'ready' as const };
      },
      waitForState: (request) => {
        if (disposed) return Promise.resolve(staleOwner());
        if (request.afterRevision !== this.getViewRevision()) {
          return Promise.resolve(this.getViewStateResult());
        }
        return new Promise<PiariumEditorMonacoStateResultV1>((resolve) => {
          let settled = false;
          const finish = (result: PiariumEditorMonacoStateResultV1): void => {
            if (settled) return;
            settled = true;
            unsubscribe();
            pendingStateWaiters.delete(cancel);
            resolve(result);
          };
          const cancel = (): void => finish(staleOwner());
          const unsubscribe = this.subscribeViewState(() => finish(
            disposed ? staleOwner() : this.getViewStateResult(),
          ));
          pendingStateWaiters.add(cancel);
        });
      },
    } satisfies PiariumEditorMonacoServiceV1;
    return {
      descriptor: serviceDescriptor,
      implementation,
      providerId: 'piarium.builtin.text',
      dispose,
    };
  }

  resetForTests(): void {
    for (const view of [...this.#views.values()]) this.#removeView(view);
    this.#decorations.clear();
    this.#owners.clear();
    this.#activeViewId = null;
    this.#nextViewGeneration = 1;
    this.#viewRevision = 0;
    this.#viewStateListeners.clear();
    this.#publish();
  }

  #withView<T>(
    request: PiariumEditorMonacoViewRequestV1,
    action: (view: LiveMonacoView) => T,
  ): T | MonacoExtensionServiceFailure {
    const view = this.#target(request);
    if (!view) {
      if (this.#views.size === 0) return { status: 'absent', reason: 'provider-inactive' };
      return { status: 'stale', reason: 'view-unavailable' };
    }
    if (request.expectedViewGeneration !== undefined && request.expectedViewGeneration !== view.generation) {
      return { status: 'stale', reason: 'view-generation-changed' };
    }
    if (request.expectedDocumentVersion !== undefined && request.expectedDocumentVersion !== documentVersion(view)) {
      return { status: 'stale', reason: 'document-version-changed' };
    }
    return action(view);
  }

  #target(request: PiariumEditorMonacoViewRequestV1): LiveMonacoView | null {
    if (request.viewId) return this.#views.get(request.viewId) ?? null;
    if (this.#activeViewId) return this.#views.get(this.#activeViewId) ?? null;
    return this.#views.values().next().value ?? null;
  }

  #viewSnapshot(view: LiveMonacoView | null) {
    return view
      ? { status: 'ready' as const, view: this.#snapshotView(view) }
      : { status: 'absent' as const, reason: 'provider-inactive' as const };
  }

  #snapshotView(view: LiveMonacoView) {
    const selection = view.editor.getSelection();
    return {
      documentVersion: documentVersion(view),
      focused: view.editor.hasWidgetFocus(),
      generation: view.generation,
      kind: view.kind,
      languageId: view.editor.getModel()?.getLanguageId() ?? 'plaintext',
      providerId: view.providerId,
      resource: { ...view.identity },
      selection: selection ? publicRange(selection) : null,
      viewId: view.viewId,
    };
  }

  #clearOwner(owner: SurfaceOwnerIdentity): void {
    for (const [key, registration] of this.#decorations) {
      if (ownerKey(registration.owner) !== ownerKey(owner)) continue;
      this.#clearDecoration(registration);
      this.#decorations.delete(key);
    }
  }

  #clearDecoration(registration: OwnedDecorations): void {
    const view = this.#views.get(registration.viewId);
    if (!view || view.generation !== registration.viewGeneration || !view.editor.getModel()) return;
    view.editor.deltaDecorations(registration.decorationIds, []);
  }

  #removeView(view: LiveMonacoView): void {
    for (const listener of view.listeners) listener.dispose();
    for (const [key, registration] of this.#decorations) {
      if (registration.viewId !== view.viewId || registration.viewGeneration !== view.generation) continue;
      this.#clearDecoration(registration);
      this.#decorations.delete(key);
    }
    this.#views.delete(view.viewId);
    if (this.#activeViewId === view.viewId) {
      this.#activeViewId = this.#views.keys().next().value ?? null;
    }
  }

  #advanceViewRevision(publishInspector: boolean): void {
    this.#viewRevision += 1;
    for (const listener of [...this.#viewStateListeners]) listener();
    if (publishInspector || this.#listeners.size > 0) this.#publish();
    else this.#inspectorDirty = true;
  }

  #refreshInspectorSnapshot(): void {
    const ownerRegistrations = new Map<string, number>();
    for (const registration of this.#decorations.values()) {
      const key = ownerKey(registration.owner);
      ownerRegistrations.set(key, (ownerRegistrations.get(key) ?? 0) + 1);
    }
    this.#snapshot = {
      activeViewId: this.#activeViewId,
      owners: [...this.#owners.entries()].map(([key, owner]) => ({
        entrypointId: owner.entrypointId,
        extensionId: owner.extensionId,
        generation: owner.generation,
        realmId: owner.realmId,
        registrationCount: ownerRegistrations.get(key) ?? 0,
      })),
      revision: this.#snapshot.revision + 1,
      views: [...this.#views.values()].map((view) => ({
        documentVersion: documentVersion(view),
        focused: view.editor.hasWidgetFocus(),
        generation: view.generation,
        kind: view.kind,
        providerId: view.providerId,
        resourceId: view.identity.resourceId,
        viewId: view.viewId,
        workspaceId: view.identity.workspaceId,
      })),
    };
    this.#inspectorDirty = false;
  }

  #publish(): void {
    this.#refreshInspectorSnapshot();
    for (const listener of this.#listeners) listener();
  }
}

const registry = new MonacoExtensionServiceRegistry();

export const registerMonacoExtensionView = (input: MonacoViewRegistration): (() => void) => (
  registry.registerView(input)
);

export const createMonacoExtensionExternalService = (
  owner: SurfaceOwnerIdentity,
): SurfaceExternalService<PiariumEditorMonacoServiceV1> => (
  registry.externalService(owner)
);

export const getMonacoExtensionInspectorSnapshot = (): MonacoExtensionInspectorSnapshot => registry.getSnapshot();
export const subscribeMonacoExtensionInspector = (listener: () => void): (() => void) => registry.subscribe(listener);
export const resetMonacoExtensionServiceForTests = (): void => registry.resetForTests();
