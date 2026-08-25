import type { editor } from 'monaco-editor/editor';

import type { DocumentIdentity } from '@/lib/documents/types';
import { getDocumentRegistry } from '@/lib/documents/session';
import type { FileEditorSettings, FileEditorSettingsPatch } from '@/lib/file-editor-settings';
import { eventMatchesShortcut, getEffectiveShortcutCombo, type ShortcutCombo } from '@/lib/shortcuts';
import { listEditorWorkbenches, setActiveWorkbenchEditorView } from '@/lib/workbench/editors/session';
import { registerWorkbenchCommand } from '@/lib/workbench/editors/commands';
import {
  getWorkbenchContextKey,
  setWorkbenchContextKey,
} from '@/lib/workbench/editors/context-keys';
import { registerWorkbenchMenuItem } from '@/lib/workbench/editors/menus';

export const FILE_EDITOR_COMMAND_IDS = {
  save: 'save-active-file',
  saveAll: 'editor.saveAll',
  find: 'editor.find',
  replace: 'editor.replace',
  goToLine: 'editor.goToLine',
  goToSymbol: 'editor.goToSymbol',
  format: 'editor.formatDocument',
  rename: 'editor.renameSymbol',
  quickFix: 'editor.quickFix',
  definition: 'editor.goToDefinition',
  references: 'editor.findReferences',
  fold: 'editor.fold',
  unfold: 'editor.unfold',
  toggleWrap: 'editor.toggleWordWrap',
  toggleMinimap: 'editor.toggleMinimap',
  cursorAbove: 'editor.addCursorAbove',
  cursorBelow: 'editor.addCursorBelow',
  focusPreviousGroup: 'editor.focusPreviousGroup',
  focusNextGroup: 'editor.focusNextGroup',
} as const;

export type FileEditorCommandId = typeof FILE_EDITOR_COMMAND_IDS[keyof typeof FILE_EDITOR_COMMAND_IDS];

type FileEditorCommandTarget = {
  editor: editor.IStandaloneCodeEditor;
  identity: DocumentIdentity;
  ownerId: string;
  getSettings(): FileEditorSettings;
  getShortcutOverrides(): Record<string, ShortcutCombo>;
  updateSettings(patch: FileEditorSettingsPatch): void;
  viewId: string;
};

const targets = new Map<string, FileEditorCommandTarget>();
let activeOwnerId: string | null = null;
const bridgeDisposers: Array<() => void> = [];
const targetListeners = new Set<() => void>();
let targetRevision = 0;

const emitTargetChange = (): void => {
  targetRevision += 1;
  for (const listener of targetListeners) listener();
};

export const getFileEditorCommandTargetRevision = (): number => targetRevision;

export const subscribeFileEditorCommandTargets = (listener: () => void): (() => void) => {
  targetListeners.add(listener);
  return () => targetListeners.delete(listener);
};

const activeTarget = (): FileEditorCommandTarget | null => (
  (activeOwnerId ? targets.get(activeOwnerId) : undefined) ?? targets.values().next().value ?? null
);

const targetForIdentity = (identity: DocumentIdentity, viewId?: string): FileEditorCommandTarget | null => (
  [...targets.values()].find((target) => (
    target.identity.workspaceId === identity.workspaceId
    && target.identity.resourceId === identity.resourceId
    && (viewId === undefined || target.viewId === viewId)
  )) ?? null
);

const setContext = (key: string, value: string | boolean | number): void => {
  setWorkbenchContextKey(key, value);
};

const refreshContext = (focused = getWorkbenchContextKey('editorTextFocus') === true): void => {
  const target = activeTarget();
  setContext('editorIsOpen', targets.size > 0);
  setContext('editorTextFocus', Boolean(target && focused));
  if (!target) {
    setContext('editorHasSelection', false);
    setContext('editorLanguageId', '');
    setContext('editorWordWrap', false);
    setContext('editorMinimap', false);
    return;
  }
  const raw = target.editor.getRawOptions();
  setContext('editorHasSelection', Boolean(target.editor.getSelection() && !target.editor.getSelection()?.isEmpty()));
  setContext('editorLanguageId', target.editor.getModel()?.getLanguageId() ?? 'plaintext');
  setContext('editorWordWrap', raw.wordWrap === 'on');
  setContext('editorMinimap', raw.minimap?.enabled === true);
};

const runAction = async (target: FileEditorCommandTarget, actionId: string): Promise<void> => {
  const action = target.editor.getAction(actionId);
  if (action?.isSupported()) await action.run();
};

export const saveFileEditorDocument = async (identity: DocumentIdentity): Promise<void> => {
  const target = targetForIdentity(identity);
  if (target?.getSettings().formatOnSave) {
    await runAction(target, 'editor.action.formatDocument').catch(() => undefined);
  }
  await getDocumentRegistry().save(identity);
};

const saveTarget = async (target: FileEditorCommandTarget): Promise<void> => {
  await saveFileEditorDocument(target.identity);
};

const saveAll = async (): Promise<void> => {
  const registry = getDocumentRegistry();
  const saves: Array<Promise<unknown>> = [];
  for (const workbench of listEditorWorkbenches()) {
    for (const resourceId of registry.dirtyResourceIds(workbench.workspaceId)) {
      saves.push(saveFileEditorDocument({ workspaceId: workbench.workspaceId, resourceId }));
    }
  }
  await Promise.all(saves);
};

const toggleSetting = (target: FileEditorCommandTarget, field: 'wordWrap' | 'minimap'): void => {
  const raw = target.editor.getRawOptions();
  const currentlyEnabled = field === 'wordWrap'
    ? raw.wordWrap === 'on'
    : raw.minimap?.enabled === true;
  target.updateSettings({ [field]: currentlyEnabled ? 'off' : 'on' });
};

const focusAdjacentGroup = (direction: -1 | 1): void => {
  const current = activeTarget();
  if (!current) return;
  const peers = [...targets.values()].filter((target) => target.identity.workspaceId === current.identity.workspaceId);
  if (peers.length < 2) return;
  const index = Math.max(0, peers.findIndex((target) => target.ownerId === current.ownerId));
  const next = peers[(index + direction + peers.length) % peers.length];
  if (!next) return;
  activeOwnerId = next.ownerId;
  setActiveWorkbenchEditorView(next.identity.workspaceId, next.viewId);
  next.editor.focus();
  refreshContext(true);
};

export const hasActiveFileEditorCommandTarget = (): boolean => activeTarget() !== null;

export const executeFileEditorCommand = async (
  identity: DocumentIdentity,
  commandId: FileEditorCommandId,
  viewId?: string,
): Promise<boolean> => {
  const target = targetForIdentity(identity, viewId);
  if (!target) return false;
  activeOwnerId = target.ownerId;
  setActiveWorkbenchEditorView(target.identity.workspaceId, target.viewId);
  refreshContext(true);
  return executeActiveFileEditorCommand(commandId);
};

export const executeActiveFileEditorCommand = async (commandId: FileEditorCommandId): Promise<boolean> => {
  const target = activeTarget();
  if (!target) return false;
  switch (commandId) {
    case FILE_EDITOR_COMMAND_IDS.save:
      await saveTarget(target);
      break;
    case FILE_EDITOR_COMMAND_IDS.saveAll:
      await saveAll();
      break;
    case FILE_EDITOR_COMMAND_IDS.find:
      await runAction(target, 'actions.find');
      break;
    case FILE_EDITOR_COMMAND_IDS.replace:
      await runAction(target, 'editor.action.startFindReplaceAction');
      break;
    case FILE_EDITOR_COMMAND_IDS.goToLine:
      await runAction(target, 'editor.action.gotoLine');
      break;
    case FILE_EDITOR_COMMAND_IDS.goToSymbol:
      await runAction(target, 'editor.action.quickOutline');
      break;
    case FILE_EDITOR_COMMAND_IDS.format:
      await runAction(target, 'editor.action.formatDocument');
      break;
    case FILE_EDITOR_COMMAND_IDS.rename:
      await runAction(target, 'editor.action.rename');
      break;
    case FILE_EDITOR_COMMAND_IDS.quickFix:
      await runAction(target, 'editor.action.quickFix');
      break;
    case FILE_EDITOR_COMMAND_IDS.definition:
      await runAction(target, 'editor.action.revealDefinition');
      break;
    case FILE_EDITOR_COMMAND_IDS.references:
      await runAction(target, 'editor.action.referenceSearch.trigger');
      break;
    case FILE_EDITOR_COMMAND_IDS.fold:
      await runAction(target, 'editor.fold');
      break;
    case FILE_EDITOR_COMMAND_IDS.unfold:
      await runAction(target, 'editor.unfold');
      break;
    case FILE_EDITOR_COMMAND_IDS.toggleWrap:
      toggleSetting(target, 'wordWrap');
      break;
    case FILE_EDITOR_COMMAND_IDS.toggleMinimap:
      toggleSetting(target, 'minimap');
      break;
    case FILE_EDITOR_COMMAND_IDS.cursorAbove:
      await runAction(target, 'editor.action.insertCursorAbove');
      break;
    case FILE_EDITOR_COMMAND_IDS.cursorBelow:
      await runAction(target, 'editor.action.insertCursorBelow');
      break;
    case FILE_EDITOR_COMMAND_IDS.focusPreviousGroup:
      focusAdjacentGroup(-1);
      break;
    case FILE_EDITOR_COMMAND_IDS.focusNextGroup:
      focusAdjacentGroup(1);
      break;
  }
  return true;
};

const shortcutCommands: ReadonlyArray<[shortcutId: string, commandId: FileEditorCommandId]> = [
  ['editor_save', FILE_EDITOR_COMMAND_IDS.save],
  ['editor_find', FILE_EDITOR_COMMAND_IDS.find],
  ['editor_replace', FILE_EDITOR_COMMAND_IDS.replace],
  ['open_go_to_line', FILE_EDITOR_COMMAND_IDS.goToLine],
  ['editor_rename', FILE_EDITOR_COMMAND_IDS.rename],
  ['editor_quick_fix', FILE_EDITOR_COMMAND_IDS.quickFix],
  ['editor_cursor_above', FILE_EDITOR_COMMAND_IDS.cursorAbove],
  ['editor_cursor_below', FILE_EDITOR_COMMAND_IDS.cursorBelow],
];

const installWorkbenchProjection = (): void => {
  if (bridgeDisposers.length > 0) return;
  const ownerId = 'piarium.monaco.editor-commands';
  for (const commandId of Object.values(FILE_EDITOR_COMMAND_IDS)) {
    bridgeDisposers.push(registerWorkbenchCommand(commandId, ownerId, async () => {
      await executeActiveFileEditorCommand(commandId);
    }));
  }
  const menuItems = [
    [FILE_EDITOR_COMMAND_IDS.save, 'editor/title', 10],
    [FILE_EDITOR_COMMAND_IDS.find, 'editor/context', 20],
    [FILE_EDITOR_COMMAND_IDS.replace, 'editor/context', 21],
    [FILE_EDITOR_COMMAND_IDS.definition, 'editor/context', 30],
    [FILE_EDITOR_COMMAND_IDS.references, 'editor/context', 31],
    [FILE_EDITOR_COMMAND_IDS.rename, 'editor/context', 32],
    [FILE_EDITOR_COMMAND_IDS.quickFix, 'editor/context', 33],
  ] as const;
  for (const [commandId, group, order] of menuItems) {
    bridgeDisposers.push(registerWorkbenchMenuItem({
      id: `menu.${commandId}`,
      commandId,
      group,
      order,
      when: { editorIsOpen: true },
    }));
  }
};

const uninstallWorkbenchProjection = (): void => {
  for (const dispose of bridgeDisposers.splice(0)) dispose();
};

export const registerFileEditorCommandTarget = (target: FileEditorCommandTarget): (() => void) => {
  targets.set(target.ownerId, target);
  if (!activeOwnerId) activeOwnerId = target.ownerId;
  installWorkbenchProjection();
  refreshContext();
  emitTargetChange();

  const disposables = [
    target.editor.onDidFocusEditorText(() => {
      activeOwnerId = target.ownerId;
      setActiveWorkbenchEditorView(target.identity.workspaceId, target.viewId);
      refreshContext(true);
    }),
    target.editor.onDidBlurEditorText(() => {
      if (activeOwnerId === target.ownerId) refreshContext(false);
    }),
    target.editor.onDidChangeCursorSelection(() => {
      if (activeOwnerId === target.ownerId) refreshContext(true);
    }),
    target.editor.onDidChangeModelLanguage(() => {
      if (activeOwnerId === target.ownerId) refreshContext(true);
    }),
    target.editor.onKeyDown((event) => {
      const browserEvent = event.browserEvent;
      if (browserEvent.isComposing || browserEvent.defaultPrevented) return;
      for (const [shortcutId, commandId] of shortcutCommands) {
        const combo = getEffectiveShortcutCombo(shortcutId, target.getShortcutOverrides());
        if (!combo || !eventMatchesShortcut(browserEvent, combo)) continue;
        event.preventDefault();
        event.stopPropagation();
        void executeActiveFileEditorCommand(commandId);
        return;
      }
    }),
  ];

  return () => {
    for (const disposable of disposables) disposable.dispose();
    const removedActiveTarget = activeOwnerId === target.ownerId;
    targets.delete(target.ownerId);
    if (removedActiveTarget) activeOwnerId = targets.keys().next().value ?? null;
    refreshContext(removedActiveTarget ? false : undefined);
    if (targets.size === 0) uninstallWorkbenchProjection();
    emitTargetChange();
  };
};

export const resetFileEditorCommandServiceForTests = (): void => {
  targets.clear();
  activeOwnerId = null;
  uninstallWorkbenchProjection();
  refreshContext(false);
  emitTargetChange();
};
