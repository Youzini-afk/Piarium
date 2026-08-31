import type { EditorAPI } from '@piarium/application-client';
import type { DocumentIdentity } from '@/lib/documents/types';
import { workspacePathFromResourceId } from '@/lib/documents/path';
import { openFileInMainEditor } from '@/lib/openFileInMainEditor';
import { getRuntimeKey } from '@piarium/application-client';
import { activeEditorTab } from '@/lib/workbench/editors/groups';
import { openWorkbenchEditor, patchEditorViewState, peekEditorWorkbench } from '@/lib/workbench/editors/session';
import { createLegacyTextEditorViewState } from '@/lib/workbench/editors/view-state-core';
import type { EditorSessionLink } from './types';

const byResource = new Map<string, EditorSessionLink>();

const keyOf = (identity: DocumentIdentity): string => `${identity.workspaceId}\0${identity.resourceId}`;

const rememberEditorSessionLink = (link: EditorSessionLink): void => {
  if (link.sessionId === '') return;
  byResource.set(keyOf(link.identity), link);
};

export const peekEditorSessionLink = (identity: DocumentIdentity): EditorSessionLink | undefined => (
  byResource.get(keyOf(identity))
);

export const revealResourceInEditor = (input: {
  workspaceId: string;
  resourceId: string;
  workspaceRoot: string;
  line?: number;
  column?: number;
  sessionId?: string;
  entryId?: string;
  toolCallId?: string;
  editor?: EditorAPI;
}): void => {
  const identity = { workspaceId: input.workspaceId, resourceId: input.resourceId };
  if (input.sessionId) {
    const link: EditorSessionLink = { identity, sessionId: input.sessionId };
    if (input.entryId) link.entryId = input.entryId;
    if (input.toolCallId) link.toolCallId = input.toolCallId;
    rememberEditorSessionLink(link);
  }
  const path = workspacePathFromResourceId(input.workspaceRoot, input.resourceId);
  const openedInMain = openFileInMainEditor(input.workspaceRoot, path, {
    ...(typeof input.line === 'number' ? { line: input.line } : {}),
    ...(typeof input.column === 'number' ? { column: input.column } : {}),
    focus: true,
  });
  if (!openedInMain) openWorkbenchEditor(input.workspaceId, input.resourceId);
  const workbench = peekEditorWorkbench(input.workspaceId);
  const active = workbench ? activeEditorTab(workbench) : undefined;
  if (active?.resourceId === input.resourceId && input.line) {
    patchEditorViewState(input.workspaceId, active.viewId, createLegacyTextEditorViewState({
      cursorLine: input.line,
      ...(input.column ? { cursorColumn: input.column } : {}),
    }));
  }
  if (input.editor && !openedInMain) {
    void input.editor.openFile(path, input.line, input.column);
  }
};

export const resetEditorSessionLinks = (runtimeKey?: string): void => {
  if (runtimeKey && runtimeKey !== getRuntimeKey()) return;
  byResource.clear();
};
