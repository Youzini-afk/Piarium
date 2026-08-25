import type { JsonValue } from "./types.js";

/** A zero-based UTF-16 code-unit edit against one captured document version. */
export interface PiariumEditorDocumentEdit {
  from: number;
  insert: string;
  to: number;
}

export interface PiariumEditorDocumentSnapshot {
  baseRevision: string | null;
  content: string;
  dirty: boolean;
  documentVersion: number;
  errorMessage?: string;
  saving: boolean;
  status: "binary" | "conflict" | "deleted" | "error" | "missing" | "ready" | "unsupported-encoding";
}

export type PiariumEditorDocumentApplyEditsResult =
  | { snapshot: PiariumEditorDocumentSnapshot; status: "applied" }
  | { snapshot: PiariumEditorDocumentSnapshot; status: "conflict" }
  | { snapshot: PiariumEditorDocumentSnapshot; status: "invalid-range" }
  | { snapshot: PiariumEditorDocumentSnapshot; status: "overlapping-ranges" }
  | { snapshot: PiariumEditorDocumentSnapshot; status: "stale" }
  | { snapshot: PiariumEditorDocumentSnapshot; status: "unsupported" };

export type PiariumEditorDocumentUpdateResult =
  | { snapshot: PiariumEditorDocumentSnapshot; status: "updated" }
  | { snapshot: PiariumEditorDocumentSnapshot; status: "conflict" }
  | { snapshot: PiariumEditorDocumentSnapshot; status: "stale" }
  | { snapshot: PiariumEditorDocumentSnapshot; status: "unsupported" };

/**
 * Stable document authority supplied to a custom editor mount. Implementations are framework-neutral;
 * views must not retain a second dirty/conflict or persistence authority.
 */
export interface PiariumEditorDocumentController {
  applyEdits(
    edits: readonly PiariumEditorDocumentEdit[],
    expectedDocumentVersion: number,
  ): Promise<PiariumEditorDocumentApplyEditsResult>;
  getSnapshot(): PiariumEditorDocumentSnapshot;
  replaceContent(content: string, expectedDocumentVersion: number): Promise<PiariumEditorDocumentUpdateResult>;
  save(expectedDocumentVersion: number): Promise<PiariumEditorDocumentUpdateResult>;
  subscribe(listener: () => void): () => void;
}

export interface PiariumEditorMonacoPositionV1 {
  /** One-based editor column. */
  column: number;
  /** One-based editor line. */
  line: number;
}

export interface PiariumEditorMonacoRangeV1 {
  end: PiariumEditorMonacoPositionV1;
  start: PiariumEditorMonacoPositionV1;
}

/** A normalized selection range; direction is not part of the v1 serialized subset. */
export type PiariumEditorMonacoSelectionV1 = PiariumEditorMonacoRangeV1;

export interface PiariumEditorMonacoViewRequestV1 {
  expectedDocumentVersion?: number;
  expectedViewGeneration?: number;
  viewId?: string;
}

export interface PiariumEditorMonacoViewSnapshotV1 {
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
  selection: PiariumEditorMonacoSelectionV1 | null;
  viewId: string;
}

export interface PiariumEditorMonacoStateSnapshotV1 {
  activeViewId: string | null;
  /** Monotonic Surface-local revision for view registration, focus, model, and selection changes. */
  revision: number;
  views: PiariumEditorMonacoViewSnapshotV1[];
}

export interface PiariumEditorMonacoWaitForStateRequestV1 {
  afterRevision: number;
}

export type PiariumEditorMonacoAbsentReasonV1 =
  | "provider-inactive"
  | "registration-unavailable"
  | "view-unavailable";

export type PiariumEditorMonacoStaleReasonV1 =
  | "document-version-changed"
  | "owner-generation-changed"
  | "view-generation-changed"
  | "view-unavailable";

export type PiariumEditorMonacoUnsupportedReasonV1 =
  | "action-unavailable"
  | "operation-unavailable";

export type PiariumEditorMonacoFailureResultV1 =
  | { reason: PiariumEditorMonacoAbsentReasonV1; status: "absent" }
  | { reason: PiariumEditorMonacoStaleReasonV1; status: "stale" }
  | { reason: PiariumEditorMonacoUnsupportedReasonV1; status: "unsupported" };

export type PiariumEditorMonacoViewResultV1 =
  | { status: "ready"; view: PiariumEditorMonacoViewSnapshotV1 }
  | PiariumEditorMonacoFailureResultV1;

export type PiariumEditorMonacoStateResultV1 =
  | { state: PiariumEditorMonacoStateSnapshotV1; status: "ready" }
  | PiariumEditorMonacoFailureResultV1;

export type PiariumEditorMonacoOperationResultV1 =
  | PiariumEditorMonacoFailureResultV1
  | {
      registrationId?: string;
      status: "ready";
      view?: PiariumEditorMonacoViewSnapshotV1;
    };

/** Declarative decoration data. It contains no Monaco object, DOM node, or callback. */
export interface PiariumEditorMonacoDecorationV1 {
  className?: string;
  glyphMarginClassName?: string;
  inlineClassName?: string;
  isWholeLine?: boolean;
  range: PiariumEditorMonacoRangeV1;
}

export interface PiariumEditorMonacoRevealRequestV1 extends PiariumEditorMonacoViewRequestV1 {
  range: PiariumEditorMonacoRangeV1;
}

export interface PiariumEditorMonacoSetSelectionRequestV1 extends PiariumEditorMonacoViewRequestV1 {
  range: PiariumEditorMonacoRangeV1;
}

export interface PiariumEditorMonacoExecuteActionRequestV1 extends PiariumEditorMonacoViewRequestV1 {
  actionId: string;
  args?: JsonValue;
}

export interface PiariumEditorMonacoSetDecorationsRequestV1 extends PiariumEditorMonacoViewRequestV1 {
  decorations: PiariumEditorMonacoDecorationV1[];
  /** Extension-chosen ID scoped to the injected activation owner. */
  sourceId: string;
}

export interface PiariumEditorMonacoClearDecorationsRequestV1 {
  sourceId: string;
}

export type PiariumEditorMonacoMaybePromise<T> = T | Promise<T>;

/** Serializable, owner-scoped subset of the optional `piarium.editor.monaco` Surface service. */
export interface PiariumEditorMonacoServiceV1 {
  clearDecorations(
    request: PiariumEditorMonacoClearDecorationsRequestV1,
  ): PiariumEditorMonacoMaybePromise<PiariumEditorMonacoOperationResultV1>;
  executeAction(
    request: PiariumEditorMonacoExecuteActionRequestV1,
  ): PiariumEditorMonacoMaybePromise<PiariumEditorMonacoOperationResultV1>;
  focus(
    request?: PiariumEditorMonacoViewRequestV1,
  ): PiariumEditorMonacoMaybePromise<PiariumEditorMonacoOperationResultV1>;
  getActiveView(): PiariumEditorMonacoMaybePromise<PiariumEditorMonacoViewResultV1>;
  getState(): PiariumEditorMonacoMaybePromise<PiariumEditorMonacoStateResultV1>;
  getView(
    request?: PiariumEditorMonacoViewRequestV1,
  ): PiariumEditorMonacoMaybePromise<PiariumEditorMonacoViewResultV1>;
  reveal(
    request: PiariumEditorMonacoRevealRequestV1,
  ): PiariumEditorMonacoMaybePromise<PiariumEditorMonacoOperationResultV1>;
  setDecorations(
    request: PiariumEditorMonacoSetDecorationsRequestV1,
  ): PiariumEditorMonacoMaybePromise<PiariumEditorMonacoOperationResultV1>;
  setSelection(
    request: PiariumEditorMonacoSetSelectionRequestV1,
  ): PiariumEditorMonacoMaybePromise<PiariumEditorMonacoOperationResultV1>;
  waitForState(
    request: PiariumEditorMonacoWaitForStateRequestV1,
  ): PiariumEditorMonacoMaybePromise<PiariumEditorMonacoStateResultV1>;
}
