import { PIARIUM_WORKBENCH_IDE_PROFILE_ID } from '@piarium/extension-contract';
import type { editor } from 'monaco-editor/editor';

import {
  normalizeFileEditorSettings,
  type FileEditorProfileToggle,
  type FileEditorSettings,
} from '@/lib/file-editor-settings';

export type FileEditorPresentationPreset = 'agent-compact' | 'ide-full';

type FileEditorPresentation = {
  lineNumbers: 'on' | 'off';
  minimap: boolean;
  stickyScroll: boolean;
  wordWrap: 'on' | 'off';
};

const PRESENTATIONS: Record<FileEditorPresentationPreset, FileEditorPresentation> = {
  'agent-compact': {
    lineNumbers: 'on',
    minimap: false,
    stickyScroll: false,
    wordWrap: 'on',
  },
  'ide-full': {
    lineNumbers: 'on',
    minimap: true,
    stickyScroll: true,
    wordWrap: 'off',
  },
};

export const fileEditorPresentationForProfile = (profileId: string): FileEditorPresentationPreset => (
  profileId === PIARIUM_WORKBENCH_IDE_PROFILE_ID ? 'ide-full' : 'agent-compact'
);

const resolveToggle = (value: FileEditorProfileToggle, profileValue: boolean): boolean => (
  value === 'profile' ? profileValue : value === 'on'
);

export const createMonacoEditorOptions = (input: {
  ariaLabel: string;
  fontSize: number;
  profileId: string;
  settings: FileEditorSettings;
}): editor.IStandaloneEditorConstructionOptions => {
  const settings = normalizeFileEditorSettings(input.settings);
  const presentation = PRESENTATIONS[fileEditorPresentationForProfile(input.profileId)];
  const lineNumbers = settings.lineNumbers === 'profile'
    ? presentation.lineNumbers
    : settings.lineNumbers;
  return {
    accessibilitySupport: settings.accessibilitySupport,
    ariaLabel: input.ariaLabel,
    automaticLayout: false,
    autoClosingBrackets: settings.autoClosingBrackets ? 'languageDefined' : 'never',
    autoClosingQuotes: settings.autoClosingQuotes ? 'languageDefined' : 'never',
    autoIndent: 'full',
    autoSurround: settings.autoSurround ? 'languageDefined' : 'never',
    bracketPairColorization: { enabled: true, independentColorPoolPerBracketType: true },
    cursorBlinking: settings.cursorBlinking,
    cursorSmoothCaretAnimation: settings.smoothScrolling ? 'on' : 'off',
    cursorStyle: settings.cursorStyle,
    dragAndDrop: true,
    find: { addExtraSpaceOnTop: false, seedSearchStringFromSelection: 'selection' },
    folding: settings.folding,
    foldingHighlight: true,
    fontFamily: 'var(--font-mono)',
    fontLigatures: settings.fontLigatures,
    fontSize: input.fontSize,
    formatOnType: settings.formatOnType,
    guides: { bracketPairs: true, bracketPairsHorizontal: true, highlightActiveBracketPair: true, indentation: true },
    lineHeight: settings.lineHeight,
    lineNumbers,
    links: true,
    matchBrackets: 'always',
    minimap: { enabled: resolveToggle(settings.minimap, presentation.minimap), showSlider: 'mouseover' },
    mouseWheelZoom: true,
    multiCursorMergeOverlapping: true,
    multiCursorModifier: 'alt',
    occurrencesHighlight: 'multiFile',
    padding: { top: 8, bottom: 8 },
    renderLineHighlight: 'all',
    renderValidationDecorations: 'on',
    renderWhitespace: settings.renderWhitespace,
    roundedSelection: true,
    scrollBeyondLastLine: false,
    smoothScrolling: settings.smoothScrolling,
    stickyScroll: { enabled: resolveToggle(settings.stickyScroll, presentation.stickyScroll) },
    suggest: { preview: true, showStatusBar: true },
    tabCompletion: 'on',
    unicodeHighlight: { ambiguousCharacters: true, invisibleCharacters: true, nonBasicASCII: false },
    wordWrap: settings.wordWrap === 'profile' ? presentation.wordWrap : settings.wordWrap,
  };
};

export const applyMonacoModelSettings = (
  model: editor.ITextModel,
  settingsValue: FileEditorSettings,
): void => {
  const settings = normalizeFileEditorSettings(settingsValue);
  if (settings.detectIndentation) {
    model.detectIndentation(settings.insertSpaces, settings.tabSize);
    return;
  }
  model.updateOptions({
    insertSpaces: settings.insertSpaces,
    tabSize: settings.tabSize,
  });
};
