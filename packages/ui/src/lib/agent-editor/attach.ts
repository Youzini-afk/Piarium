import { getRuntimeKey } from '@/lib/runtime-switch';
import { getDocumentRegistry } from '@/lib/documents/session';
import { resourceIdFromWorkspacePath } from '@/lib/documents/path';
import { languageIdFromResourceId } from '@/lib/language-services/language-id';
import { usePiEditorContextStore } from '@/stores/usePiEditorContextStore';
import { addEditorContextAttachment } from './attachments';
import { sliceDocumentRange } from './range';
import type { EditorContextAttachment, EditorContextAttachmentKind, EditorContextRange } from './types';

const fileNameOf = (resourceId: string): string => resourceId.split('/').pop() || resourceId;

const resourceIdFor = (workspaceRoot: string, filePath: string, relativePath: string): string => (
  resourceIdFromWorkspacePath(workspaceRoot, filePath) ?? relativePath.replace(/\\/g, '/')
);

export const attachEditorContext = (input: {
  sessionId: string;
  workspaceId: string;
  resourceId: string;
  kind: EditorContextAttachmentKind;
  range?: EditorContextRange;
  diagnosticMessage?: string;
  patch?: string;
  label?: string;
  text?: string;
}): EditorContextAttachment | { status: 'wrong-runtime' } | { status: 'missing-document' } => {
  const runtimeKey = getRuntimeKey();
  const identity = { workspaceId: input.workspaceId, resourceId: input.resourceId };
  const record = getDocumentRegistry().get(identity);
  const dirty = record?.dirty === true;
  const source = input.kind === 'selection' || (dirty && (input.kind === 'editor' || input.kind === 'diff'))
    ? 'unsaved-buffer'
    : 'saved';
  let text: string | undefined;
  if (source === 'unsaved-buffer') {
    if (!record) return { status: 'missing-document' };
    text = input.range ? sliceDocumentRange(record.buffer, input.range) : record.buffer;
  }
  const attachment: EditorContextAttachment = {
    id: crypto.randomUUID(),
    runtimeKey,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    resourceId: input.resourceId,
    label: input.label ?? fileNameOf(input.resourceId),
    documentRevision: record?.baseRevision ?? null,
    localEditRevision: record?.localEditRevision ?? 0,
    source,
    kind: input.kind,
  };
  if (input.range) attachment.range = input.range;
  if (input.kind !== 'diff') attachment.languageId = languageIdFromResourceId(input.resourceId);
  if (text !== undefined) attachment.text = text;
  if (input.diagnosticMessage) attachment.diagnosticMessage = input.diagnosticMessage;
  if (input.patch) attachment.patch = input.patch;
  if (input.text !== undefined) attachment.text = input.text;
  return addEditorContextAttachment(attachment);
};

export const attachActiveEditorContext = (input: {
  sessionId: string;
  workspaceId: string;
  workspaceRoot: string;
  kind: 'editor' | 'selection';
}): EditorContextAttachment | { status: 'wrong-runtime' | 'missing-editor' | 'missing-selection' | 'missing-document' } => {
  const file = usePiEditorContextStore.getState().activeEditorFile;
  if (!file) return { status: 'missing-editor' };
  const resourceId = resourceIdFor(input.workspaceRoot, file.filePath, file.relativePath);
  if (input.kind === 'selection') {
    if (!file.selection) return { status: 'missing-selection' };
    const fromRegistry = attachEditorContext({
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      resourceId,
      kind: 'selection',
      range: {
        startLine: file.selection.startLine,
        startColumn: file.selection.startColumn ?? 1,
        endLine: file.selection.endLine,
        endColumn: file.selection.endColumn ?? 1,
      },
      label: file.relativePath,
      text: file.selection.text,
    });
    if (!('status' in fromRegistry) || fromRegistry.status !== 'missing-document') return fromRegistry;
    const runtimeKey = getRuntimeKey();
    return addEditorContextAttachment({
      id: crypto.randomUUID(),
      runtimeKey,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      resourceId,
      label: file.relativePath,
      documentRevision: null,
      localEditRevision: 0,
      source: 'unsaved-buffer',
      kind: 'selection',
      range: {
        startLine: file.selection.startLine,
        startColumn: file.selection.startColumn ?? 1,
        endLine: file.selection.endLine,
        endColumn: file.selection.endColumn ?? 1,
      },
      languageId: languageIdFromResourceId(resourceId),
      text: file.selection.text,
    });
  }
  const fromRegistry = attachEditorContext({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    resourceId,
    kind: 'editor',
    label: file.relativePath,
  });
  if (!('status' in fromRegistry) || fromRegistry.status !== 'missing-document') return fromRegistry;
  const runtimeKey = getRuntimeKey();
  return addEditorContextAttachment({
    id: crypto.randomUUID(),
    runtimeKey,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    resourceId,
    label: file.relativePath,
    documentRevision: null,
    localEditRevision: 0,
    source: 'saved',
    kind: 'editor',
    languageId: languageIdFromResourceId(resourceId),
  });
};
