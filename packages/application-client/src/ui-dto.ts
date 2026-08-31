/**
 * Framework-neutral DTO types that were previously owned by packages/ui.
 * These are pure data types with no React, Zustand, or UI component dependencies.
 */

export interface WorktreeMetadata {
  source?: 'sdk';
  path: string;
  projectDirectory: string;
  branch: string;
  label: string;
  name?: string;
  kind?: 'pr' | 'standard';
  createdFromBranch?: string;
  relativePath?: string;
  status?: {
    isDirty: boolean;
    ahead?: number;
    behind?: number;
    upstream?: string | null;
  };
  worktreeRoot?: string;
  worktreeStatus?: 'pending' | 'ready' | 'missing' | 'invalid' | 'not-a-repo';
  headState?: 'branch' | 'detached' | 'unborn';
  worktreeSource?: 'existing' | 'created-for-session';
}

export type DraftStarterType = 'command' | 'skill';

export type DraftStarterRef = {
  type: DraftStarterType;
  name: string;
};

export type FileEditorProfileToggle = 'profile' | 'on' | 'off';
export type FileEditorLineNumbers = FileEditorProfileToggle | 'relative';
export type FileEditorWhitespace = 'none' | 'boundary' | 'selection' | 'trailing' | 'all';
export type FileEditorCursorStyle = 'line' | 'block' | 'underline';
export type FileEditorCursorBlinking = 'blink' | 'smooth' | 'phase' | 'expand' | 'solid';
export type FileEditorAccessibilitySupport = 'auto' | 'on' | 'off';

export interface FileEditorSettings {
  accessibilitySupport: FileEditorAccessibilitySupport;
  autoClosingBrackets: boolean;
  autoClosingQuotes: boolean;
  autoSurround: boolean;
  cursorBlinking: FileEditorCursorBlinking;
  cursorStyle: FileEditorCursorStyle;
  detectIndentation: boolean;
  folding: boolean;
  fontLigatures: boolean;
  formatOnSave: boolean;
  formatOnType: boolean;
  insertSpaces: boolean;
  lineHeight: number;
  lineNumbers: FileEditorLineNumbers;
  minimap: FileEditorProfileToggle;
  renderWhitespace: FileEditorWhitespace;
  smoothScrolling: boolean;
  stickyScroll: FileEditorProfileToggle;
  tabSize: number;
  wordWrap: FileEditorProfileToggle;
}

export type FileEditorSettingsPatch = Partial<FileEditorSettings>;
