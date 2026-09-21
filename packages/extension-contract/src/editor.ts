import type { JsonValue } from "./types.js";

/** A zero-based UTF-16 code-unit edit against one captured document version. */
export interface VarinEditorDocumentEdit {
  from: number;
  insert: string;
  to: number;
}

export interface VarinEditorDocumentSnapshot {
  baseRevision: string | null;
  content: string;
  dirty: boolean;
  documentVersion: number;
  errorMessage?: string;
  saving: boolean;
  status: "binary" | "conflict" | "deleted" | "error" | "missing" | "ready" | "unsupported-encoding";
}

export type VarinEditorDocumentApplyEditsResult =
  | { snapshot: VarinEditorDocumentSnapshot; status: "applied" }
  | { snapshot: VarinEditorDocumentSnapshot; status: "conflict" }
  | { snapshot: VarinEditorDocumentSnapshot; status: "invalid-range" }
  | { snapshot: VarinEditorDocumentSnapshot; status: "overlapping-ranges" }
  | { snapshot: VarinEditorDocumentSnapshot; status: "stale" }
  | { snapshot: VarinEditorDocumentSnapshot; status: "unsupported" };

export type VarinEditorDocumentUpdateResult =
  | { snapshot: VarinEditorDocumentSnapshot; status: "updated" }
  | { snapshot: VarinEditorDocumentSnapshot; status: "conflict" }
  | { snapshot: VarinEditorDocumentSnapshot; status: "stale" }
  | { snapshot: VarinEditorDocumentSnapshot; status: "unsupported" };

/**
 * Stable document authority supplied to a custom editor mount. Implementations are framework-neutral;
 * views must not retain a second dirty/conflict or persistence authority.
 */
export interface VarinEditorDocumentController {
  applyEdits(
    edits: readonly VarinEditorDocumentEdit[],
    expectedDocumentVersion: number,
  ): Promise<VarinEditorDocumentApplyEditsResult>;
  getSnapshot(): VarinEditorDocumentSnapshot;
  replaceContent(content: string, expectedDocumentVersion: number): Promise<VarinEditorDocumentUpdateResult>;
  save(expectedDocumentVersion: number): Promise<VarinEditorDocumentUpdateResult>;
  subscribe(listener: () => void): () => void;
}

export interface VarinEditorMonacoPositionV1 {
  /** One-based editor column. */
  column: number;
  /** One-based editor line. */
  line: number;
}

export interface VarinEditorMonacoRangeV1 {
  end: VarinEditorMonacoPositionV1;
  start: VarinEditorMonacoPositionV1;
}

/** A normalized selection range; direction is not part of the v1 serialized subset. */
export type VarinEditorMonacoSelectionV1 = VarinEditorMonacoRangeV1;

export interface VarinEditorMonacoViewRequestV1 {
  expectedDocumentVersion?: number;
  expectedViewGeneration?: number;
  viewId?: string;
}

export interface VarinEditorMonacoViewSnapshotV1 {
  documentVersion: number;
  focused: boolean;
  generation: number;
  kind: "diff-modified" | "text";
  languageId: string;
  providerId: string;
  resource: {
    resourceId: string;
    workspaceId: string;
  };
  selection: VarinEditorMonacoSelectionV1 | null;
  viewId: string;
}

export interface VarinEditorMonacoStateSnapshotV1 {
  activeViewId: string | null;
  /** Monotonic Surface-local revision for view registration, focus, model, and selection changes. */
  revision: number;
  views: VarinEditorMonacoViewSnapshotV1[];
}

export interface VarinEditorMonacoWaitForStateRequestV1 {
  afterRevision: number;
}

export type VarinEditorMonacoAbsentReasonV1 =
  | "provider-inactive"
  | "registration-unavailable"
  | "view-unavailable";

export type VarinEditorMonacoStaleReasonV1 =
  | "document-version-changed"
  | "owner-generation-changed"
  | "view-generation-changed"
  | "view-unavailable";

export type VarinEditorMonacoUnsupportedReasonV1 =
  | "action-unavailable"
  | "operation-unavailable";

export type VarinEditorMonacoFailureResultV1 =
  | { reason: VarinEditorMonacoAbsentReasonV1; status: "absent" }
  | { reason: VarinEditorMonacoStaleReasonV1; status: "stale" }
  | { reason: VarinEditorMonacoUnsupportedReasonV1; status: "unsupported" };

export type VarinEditorMonacoViewResultV1 =
  | { status: "ready"; view: VarinEditorMonacoViewSnapshotV1 }
  | VarinEditorMonacoFailureResultV1;

export type VarinEditorMonacoStateResultV1 =
  | { state: VarinEditorMonacoStateSnapshotV1; status: "ready" }
  | VarinEditorMonacoFailureResultV1;

export type VarinEditorMonacoOperationResultV1 =
  | VarinEditorMonacoFailureResultV1
  | {
      registrationId?: string;
      status: "ready";
      view?: VarinEditorMonacoViewSnapshotV1;
    };

/** Declarative decoration data. It contains no Monaco object, DOM node, or callback. */
export interface VarinEditorMonacoDecorationV1 {
  className?: string;
  glyphMarginClassName?: string;
  inlineClassName?: string;
  isWholeLine?: boolean;
  range: VarinEditorMonacoRangeV1;
}

export interface VarinEditorMonacoRevealRequestV1 extends VarinEditorMonacoViewRequestV1 {
  range: VarinEditorMonacoRangeV1;
}

export interface VarinEditorMonacoSetSelectionRequestV1 extends VarinEditorMonacoViewRequestV1 {
  range: VarinEditorMonacoRangeV1;
}

export interface VarinEditorMonacoExecuteActionRequestV1 extends VarinEditorMonacoViewRequestV1 {
  actionId: string;
  args?: JsonValue;
}

export interface VarinEditorMonacoSetDecorationsRequestV1 extends VarinEditorMonacoViewRequestV1 {
  decorations: VarinEditorMonacoDecorationV1[];
  /** Extension-chosen ID scoped to the injected activation owner. */
  sourceId: string;
}

export interface VarinEditorMonacoClearDecorationsRequestV1 {
  sourceId: string;
}

export type VarinEditorMonacoMaybePromise<T> = T | Promise<T>;

/** Serializable, owner-scoped subset of the optional `varin.editor.monaco` Surface service. */
export interface VarinEditorMonacoServiceV1 {
  clearDecorations(
    request: VarinEditorMonacoClearDecorationsRequestV1,
  ): VarinEditorMonacoMaybePromise<VarinEditorMonacoOperationResultV1>;
  executeAction(
    request: VarinEditorMonacoExecuteActionRequestV1,
  ): VarinEditorMonacoMaybePromise<VarinEditorMonacoOperationResultV1>;
  focus(
    request?: VarinEditorMonacoViewRequestV1,
  ): VarinEditorMonacoMaybePromise<VarinEditorMonacoOperationResultV1>;
  getActiveView(): VarinEditorMonacoMaybePromise<VarinEditorMonacoViewResultV1>;
  getState(): VarinEditorMonacoMaybePromise<VarinEditorMonacoStateResultV1>;
  getView(
    request?: VarinEditorMonacoViewRequestV1,
  ): VarinEditorMonacoMaybePromise<VarinEditorMonacoViewResultV1>;
  reveal(
    request: VarinEditorMonacoRevealRequestV1,
  ): VarinEditorMonacoMaybePromise<VarinEditorMonacoOperationResultV1>;
  setDecorations(
    request: VarinEditorMonacoSetDecorationsRequestV1,
  ): VarinEditorMonacoMaybePromise<VarinEditorMonacoOperationResultV1>;
  setSelection(
    request: VarinEditorMonacoSetSelectionRequestV1,
  ): VarinEditorMonacoMaybePromise<VarinEditorMonacoOperationResultV1>;
  waitForState(
    request: VarinEditorMonacoWaitForStateRequestV1,
  ): VarinEditorMonacoMaybePromise<VarinEditorMonacoStateResultV1>;
}
