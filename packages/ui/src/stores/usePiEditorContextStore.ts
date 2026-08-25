import { create } from 'zustand';

import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';

export interface PiEditorSelection {
  endColumn?: number;
  endLine: number;
  startColumn?: number;
  startLine: number;
  text: string;
}

export interface PiActiveEditorFile {
  documentInstanceId: string;
  fileName: string;
  filePath: string;
  fileSize: number | null;
  relativePath: string;
  runtimeKey: string;
  selection: PiEditorSelection | null;
  dirty: boolean;
  viewId: string;
  workspaceId: string | null;
}

interface PiEditorContextStoreState {
  activeEditorFile: PiActiveEditorFile | null;
}

const filesByOwner = new Map<string, PiActiveEditorFile>();
let activeOwnerId: string | null = null;

const normalizedString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
};

const normalizeSelection = (value: unknown): PiEditorSelection | null => {
  if (!value || typeof value !== 'object') return null;
  const selection = value as Record<string, unknown>;
  const startLine = selection.startLine;
  const endLine = selection.endLine;
  if (
    !Number.isInteger(startLine)
    || !Number.isInteger(endLine)
    || (startLine as number) < 1
    || (endLine as number) < (startLine as number)
    || typeof selection.text !== 'string'
    || selection.text.length === 0
  ) return null;
  return {
    ...(Number.isInteger(selection.endColumn) && Number(selection.endColumn) >= 1
      ? { endColumn: Number(selection.endColumn) }
      : {}),
    endLine: endLine as number,
    ...(Number.isInteger(selection.startColumn) && Number(selection.startColumn) >= 1
      ? { startColumn: Number(selection.startColumn) }
      : {}),
    startLine: startLine as number,
    text: selection.text,
  };
};

export const normalizePiActiveEditorFile = (value: unknown): PiActiveEditorFile | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const fileName = normalizedString(record.fileName);
  const filePath = normalizedString(record.filePath);
  const relativePath = normalizedString(record.relativePath);
  const runtimeKey = normalizedString(record.runtimeKey);
  const workspaceIdIsNull = record.workspaceId === null;
  const workspaceId = workspaceIdIsNull ? null : normalizedString(record.workspaceId);
  const documentInstanceId = normalizedString(record.documentInstanceId);
  const viewId = normalizedString(record.viewId);
  if (
    !fileName
    || !filePath
    || !relativePath
    || !runtimeKey
    || (!workspaceIdIsNull && !workspaceId)
    || !documentInstanceId
    || !viewId
  ) {
    return null;
  }
  const fileSize = record.fileSize === null
    ? null
    : typeof record.fileSize === 'number' && Number.isFinite(record.fileSize) && record.fileSize >= 0
      ? record.fileSize
      : null;
  return {
    fileName,
    filePath,
    fileSize,
    relativePath,
    runtimeKey,
    selection: normalizeSelection(record.selection),
    dirty: record.dirty === true,
    documentInstanceId,
    viewId,
    workspaceId,
  };
};

const sameSelection = (left: PiEditorSelection | null, right: PiEditorSelection | null): boolean => (
  left === right
  || (left !== null
    && right !== null
    && left.startLine === right.startLine
    && left.endLine === right.endLine
    && left.startColumn === right.startColumn
    && left.endColumn === right.endColumn
    && left.text === right.text)
);

const sameActiveEditorFile = (left: PiActiveEditorFile | null, right: PiActiveEditorFile | null): boolean => (
  left === right
  || (left !== null
    && right !== null
    && left.fileName === right.fileName
    && left.filePath === right.filePath
    && left.fileSize === right.fileSize
    && left.relativePath === right.relativePath
    && left.runtimeKey === right.runtimeKey
    && left.workspaceId === right.workspaceId
    && left.documentInstanceId === right.documentInstanceId
    && left.viewId === right.viewId
    && left.dirty === right.dirty
    && sameSelection(left.selection, right.selection))
);

export const usePiEditorContextStore = create<PiEditorContextStoreState>(() => ({
  activeEditorFile: null,
}));

const publishActive = (file: PiActiveEditorFile | null): void => {
  const current = usePiEditorContextStore.getState().activeEditorFile;
  if (sameActiveEditorFile(current, file)) return;
  usePiEditorContextStore.setState({ activeEditorFile: file });
};

export const publishPiEditorContext = (ownerId: string, value: PiActiveEditorFile): void => {
  const file = normalizePiActiveEditorFile(value);
  if (!ownerId || !file || file.runtimeKey !== getRuntimeKey()) return;
  filesByOwner.set(ownerId, file);
  if (activeOwnerId === ownerId) publishActive(file);
};

export const activatePiEditorContextOwner = (ownerId: string | null): void => {
  activeOwnerId = ownerId;
  publishActive(ownerId ? filesByOwner.get(ownerId) ?? null : null);
};

export const releasePiEditorContextOwner = (ownerId: string): void => {
  filesByOwner.delete(ownerId);
  if (activeOwnerId !== ownerId) return;
  activeOwnerId = null;
  publishActive(null);
};

export const resetPiEditorContext = (): void => {
  filesByOwner.clear();
  activeOwnerId = null;
  publishActive(null);
};

subscribeRuntimeEndpointWillChange(resetPiEditorContext);
