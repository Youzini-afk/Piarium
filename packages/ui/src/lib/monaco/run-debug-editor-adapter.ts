import type { editor } from 'monaco-editor/editor';

import type { DocumentIdentity } from '@/lib/documents/types';
import {
  peekRunDebugEditorProjection,
  subscribeRunDebugEditorProjection,
  toggleRunDebugBreakpoint,
} from '@/lib/run-debug/session';
import type { MonacoRuntime } from './runtime';

export const RUN_DEBUG_DECORATION_CLASS_NAMES = {
  breakpointGlyph: 'piarium-monaco-breakpoint-glyph',
  currentFrameGlyph: 'piarium-monaco-current-debug-frame-glyph',
  currentFrameLine: 'piarium-monaco-current-debug-frame-line',
  testFailureGlyph: 'piarium-monaco-test-failure-glyph',
  testFailureLine: 'piarium-monaco-test-failure-line',
} as const;

type RunDebugEditorAdapterOptions = {
  editor: editor.IStandaloneCodeEditor;
  identity: DocumentIdentity;
  monaco: MonacoRuntime;
};

export type RunDebugEditorAdapter = {
  dispose(): void;
};

const wholeLineDecoration = (
  lineNumber: number,
  options: editor.IModelDecorationOptions,
): editor.IModelDeltaDecoration => ({
  range: {
    startLineNumber: lineNumber,
    startColumn: 1,
    endLineNumber: lineNumber,
    endColumn: 1,
  },
  options: { ...options, isWholeLine: true },
});

export const createRunDebugEditorAdapter = ({
  editor: editorInstance,
  identity,
  monaco,
}: RunDebugEditorAdapterOptions): RunDebugEditorAdapter => {
  const decorations = editorInstance.createDecorationsCollection();
  let disposed = false;

  const refresh = (): void => {
    if (disposed) return;
    const model = editorInstance.getModel();
    if (!model) {
      decorations.clear();
      return;
    }
    const lineCount = model.getLineCount();
    const projection = peekRunDebugEditorProjection(identity.workspaceId);
    const next: editor.IModelDeltaDecoration[] = [];
    for (const breakpoint of projection.breakpoints) {
      if (
        breakpoint.resourceId !== identity.resourceId
        || breakpoint.line < 1
        || breakpoint.line > lineCount
      ) continue;
      next.push(wholeLineDecoration(breakpoint.line, {
        glyphMarginClassName: RUN_DEBUG_DECORATION_CLASS_NAMES.breakpointGlyph,
      }));
    }
    const frame = projection.currentDebugFrame;
    if (
      frame?.resourceId === identity.resourceId
      && frame.line >= 1
      && frame.line <= lineCount
    ) {
      next.push(wholeLineDecoration(frame.line, {
        className: RUN_DEBUG_DECORATION_CLASS_NAMES.currentFrameLine,
        glyphMarginClassName: RUN_DEBUG_DECORATION_CLASS_NAMES.currentFrameGlyph,
      }));
    }
    const failure = projection.latestTestFailure;
    if (
      failure?.resourceId === identity.resourceId
      && typeof failure.line === 'number'
      && failure.line >= 1
      && failure.line <= lineCount
    ) {
      next.push(wholeLineDecoration(failure.line, {
        className: RUN_DEBUG_DECORATION_CLASS_NAMES.testFailureLine,
        glyphMarginClassName: RUN_DEBUG_DECORATION_CLASS_NAMES.testFailureGlyph,
      }));
    }
    decorations.set(next);
  };

  const unsubscribeProjection = subscribeRunDebugEditorProjection(identity.workspaceId, refresh);
  const disposables = [
    editorInstance.onDidChangeModel(refresh),
    editorInstance.onMouseDown((event) => {
      const browserTarget = event.event?.browserEvent?.target;
      if (
        disposed
        || event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN
        || !event.target.position
        || (
          typeof Element !== 'undefined'
          && browserTarget instanceof Element
          && browserTarget.closest('.piarium-editor-inline-comment-glyph')
        )
      ) return;
      void toggleRunDebugBreakpoint(identity, event.target.position.lineNumber).catch(() => undefined);
    }),
  ];
  refresh();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeProjection();
      for (const disposable of disposables) disposable.dispose();
      decorations.clear();
    },
  };
};
