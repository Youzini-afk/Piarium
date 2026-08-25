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

export const DEFAULT_FILE_EDITOR_SETTINGS: Readonly<FileEditorSettings> = Object.freeze({
  accessibilitySupport: 'auto',
  autoClosingBrackets: true,
  autoClosingQuotes: true,
  autoSurround: true,
  cursorBlinking: 'blink',
  cursorStyle: 'line',
  detectIndentation: true,
  folding: true,
  fontLigatures: false,
  formatOnSave: false,
  formatOnType: true,
  insertSpaces: true,
  lineHeight: 0,
  lineNumbers: 'profile',
  minimap: 'profile',
  renderWhitespace: 'selection',
  smoothScrolling: true,
  stickyScroll: 'profile',
  tabSize: 2,
  wordWrap: 'profile',
});

const PROFILE_TOGGLES = new Set<FileEditorProfileToggle>(['profile', 'on', 'off']);
const LINE_NUMBERS = new Set<FileEditorLineNumbers>(['profile', 'on', 'off', 'relative']);
const WHITESPACE = new Set<FileEditorWhitespace>(['none', 'boundary', 'selection', 'trailing', 'all']);
const CURSOR_STYLES = new Set<FileEditorCursorStyle>(['line', 'block', 'underline']);
const CURSOR_BLINKING = new Set<FileEditorCursorBlinking>(['blink', 'smooth', 'phase', 'expand', 'solid']);
const ACCESSIBILITY = new Set<FileEditorAccessibilitySupport>(['auto', 'on', 'off']);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const positiveInteger = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
);

const nonNegativeNumber = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
);

/**
 * Accepts only known fields and values. Missing or malformed fields are omitted so callers can
 * merge the patch over their last valid settings instead of replacing them with guessed defaults.
 */
export const sanitizeFileEditorSettingsPatch = (value: unknown): FileEditorSettingsPatch | null => {
  if (!isRecord(value)) return null;
  const patch: FileEditorSettingsPatch = {};
  const booleanFields = [
    'autoClosingBrackets',
    'autoClosingQuotes',
    'autoSurround',
    'detectIndentation',
    'folding',
    'fontLigatures',
    'formatOnSave',
    'formatOnType',
    'insertSpaces',
    'smoothScrolling',
  ] as const;
  for (const field of booleanFields) {
    if (typeof value[field] === 'boolean') patch[field] = value[field];
  }
  if (ACCESSIBILITY.has(value.accessibilitySupport as FileEditorAccessibilitySupport)) {
    patch.accessibilitySupport = value.accessibilitySupport as FileEditorAccessibilitySupport;
  }
  if (CURSOR_BLINKING.has(value.cursorBlinking as FileEditorCursorBlinking)) {
    patch.cursorBlinking = value.cursorBlinking as FileEditorCursorBlinking;
  }
  if (CURSOR_STYLES.has(value.cursorStyle as FileEditorCursorStyle)) {
    patch.cursorStyle = value.cursorStyle as FileEditorCursorStyle;
  }
  if (LINE_NUMBERS.has(value.lineNumbers as FileEditorLineNumbers)) {
    patch.lineNumbers = value.lineNumbers as FileEditorLineNumbers;
  }
  if (PROFILE_TOGGLES.has(value.minimap as FileEditorProfileToggle)) {
    patch.minimap = value.minimap as FileEditorProfileToggle;
  }
  if (WHITESPACE.has(value.renderWhitespace as FileEditorWhitespace)) {
    patch.renderWhitespace = value.renderWhitespace as FileEditorWhitespace;
  }
  if (PROFILE_TOGGLES.has(value.stickyScroll as FileEditorProfileToggle)) {
    patch.stickyScroll = value.stickyScroll as FileEditorProfileToggle;
  }
  if (PROFILE_TOGGLES.has(value.wordWrap as FileEditorProfileToggle)) {
    patch.wordWrap = value.wordWrap as FileEditorProfileToggle;
  }
  const tabSize = positiveInteger(value.tabSize);
  if (tabSize !== undefined) patch.tabSize = tabSize;
  const lineHeight = nonNegativeNumber(value.lineHeight);
  if (lineHeight !== undefined) patch.lineHeight = lineHeight;
  return patch;
};

export const normalizeFileEditorSettings = (
  value: unknown,
  fallback: Readonly<FileEditorSettings> = DEFAULT_FILE_EDITOR_SETTINGS,
): FileEditorSettings => ({
  ...fallback,
  ...(sanitizeFileEditorSettingsPatch(value) ?? {}),
});
