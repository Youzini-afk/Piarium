import { create } from 'zustand';

export interface PiEditorSelection {
  endLine: number;
  startLine: number;
  text: string;
}

export interface PiActiveEditorFile {
  fileName: string;
  filePath: string;
  fileSize: number | null;
  relativePath: string;
  selection: PiEditorSelection | null;
  dirty: boolean;
}

interface PiEditorContextStoreState {
  activeEditorFile: PiActiveEditorFile | null;
  setActiveEditorFile(file: PiActiveEditorFile | null): void;
}

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
    endLine: endLine as number,
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
  if (!fileName || !filePath || !relativePath) return null;
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
    selection: normalizeSelection(record.selection),
    dirty: record.dirty === true,
  };
};

const sameSelection = (left: PiEditorSelection | null, right: PiEditorSelection | null): boolean => (
  left === right
  || (left !== null
    && right !== null
    && left.startLine === right.startLine
    && left.endLine === right.endLine
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
    && left.dirty === right.dirty
    && sameSelection(left.selection, right.selection))
);

export const usePiEditorContextStore = create<PiEditorContextStoreState>((set, get) => ({
  activeEditorFile: null,
  setActiveEditorFile: (file) => {
    if (sameActiveEditorFile(get().activeEditorFile, file)) return;
    set({ activeEditorFile: file });
  },
}));
