import type { SurfaceActivationContext } from '@piarium/extension-surface';
import { toast } from '@/components/ui';
import { startPiSessionDraftFromNavigation } from '@/lib/pi-runtime/sessionNavigation';
import { createPiWorktreeSession } from '@/lib/pi-runtime/worktreeSession';
import { workspaceEvents } from '@/lib/workspaceEvents';
import { useUIStore } from '@/stores/useUIStore';
import { getDocumentRegistry } from '@/lib/documents/session';
import { activeEditorTab } from '@/lib/workbench/editors/groups';
import {
  closeWorkbenchEditor,
  ensureEditorWorkbench,
  getActiveWorkbenchWorkspaceId,
  splitActiveEditor,
} from '@/lib/workbench/editors/session';
import type { WorkbenchCommandImplementation, WorkbenchCommandMeta } from './surface-command-types';

export const BUILTIN_COMMANDS_EXTENSION_ID = 'piarium.builtin.commands';

interface BuiltinCommandDefinition {
  implementation: WorkbenchCommandImplementation;
  meta: WorkbenchCommandMeta;
}

const command = (
  meta: WorkbenchCommandMeta,
  execute: WorkbenchCommandImplementation['execute'],
): BuiltinCommandDefinition => ({ meta, implementation: { execute } });

const reportFailure = (title: string, error: unknown): void => {
  toast.error(title, { description: error instanceof Error ? error.message : String(error) });
};

const BUILTIN_WORKBENCH_COMMANDS: readonly BuiltinCommandDefinition[] = [
  command({ commandId: 'new-session', titleKey: 'commandPalette.item.newSession', icon: 'add', shortcutId: 'new_chat', keywords: ['new', 'session'], order: 0 }, async () => {
    try {
      await startPiSessionDraftFromNavigation();
    } catch (error) {
      reportFailure('Failed to create Pi session', error);
    }
  }),
  command({ commandId: 'new-worktree', titleKey: 'commandPalette.item.newWorktreeDraft', icon: 'git-branch', shortcutId: 'new_chat_worktree', keywords: ['new', 'worktree', 'session'], order: 1 }, async () => {
    try {
      await createPiWorktreeSession();
    } catch (error) {
      reportFailure('Failed to create Pi worktree session', error);
    }
  }),
  command({ commandId: 'add-project', titleKey: 'commandPalette.item.addProject', icon: 'folder-add', keywords: ['add', 'project', 'workspace'], order: 2 }, () => {
    workspaceEvents.requestDirectoryDialog();
  }),
  command({ commandId: 'toggle-sidebar', titleKey: 'commandPalette.item.toggleSidebar', mobileTitleKey: 'commandPalette.item.showSessionSwitcher', icon: 'layout-left', shortcutId: 'toggle_sidebar', keywords: ['sidebar', 'session switcher'], order: 3 }, ({ isMobile }) => {
    const state = useUIStore.getState();
    if (isMobile) state.setSessionSwitcherOpen(!state.isSessionSwitcherOpen);
    else state.toggleSidebar();
  }),
  command({ commandId: 'toggle-terminal', titleKey: 'commandPalette.item.toggleTerminal', icon: 'terminal-box', shortcutId: 'toggle_terminal', keywords: ['terminal', 'shell'], order: 4 }, ({ currentDirectory }) => {
    if (currentDirectory) useUIStore.getState().openContextSurface(currentDirectory, 'terminal');
  }),
  command({ commandId: 'context-usage', titleKey: 'commandPalette.item.showContextUsage', icon: 'pie-chart', keywords: ['context', 'usage'], order: 5 }, ({ currentDirectory }) => {
    if (currentDirectory) useUIStore.getState().openContextOverview(currentDirectory);
  }),
  command({ commandId: 'open-settings', titleKey: 'commandPalette.item.openSettings', icon: 'settings-3', shortcutId: 'open_settings', keywords: ['settings', 'preferences'], order: 6 }, () => {
    useUIStore.getState().setSettingsDialogOpen(true);
  }),
  command({ commandId: 'split-editor', titleKey: 'commandPalette.item.splitEditor', icon: 'split-cells-horizontal', keywords: ['split', 'editor'], order: 7 }, () => {
    const workspaceId = getActiveWorkbenchWorkspaceId();
    if (workspaceId) splitActiveEditor(workspaceId, 'vertical');
  }),
  command({ commandId: 'split-editor-orthogonal', titleKey: 'commandPalette.item.splitEditorOrthogonal', icon: 'split-cells-horizontal', keywords: ['split', 'editor', 'horizontal'], order: 8 }, () => {
    const workspaceId = getActiveWorkbenchWorkspaceId();
    if (workspaceId) splitActiveEditor(workspaceId, 'horizontal');
  }),
  command({ commandId: 'close-editor', titleKey: 'commandPalette.item.closeEditor', icon: 'close', keywords: ['close', 'editor'], order: 9 }, () => {
    const workspaceId = getActiveWorkbenchWorkspaceId();
    if (!workspaceId) return;
    const tab = activeEditorTab(ensureEditorWorkbench(workspaceId));
    if (tab) closeWorkbenchEditor(workspaceId, tab.tabId);
  }),
  command({ commandId: 'save-active-file', titleKey: 'commandPalette.item.saveActiveFile', icon: 'save-3', keywords: ['save', 'file', 'editor'], order: 10 }, () => {
    const workspaceId = getActiveWorkbenchWorkspaceId();
    if (!workspaceId) return;
    const tab = activeEditorTab(ensureEditorWorkbench(workspaceId));
    if (!tab) return;
    try {
      void getDocumentRegistry().save({ workspaceId, resourceId: tab.resourceId }).catch((error) => {
        reportFailure('Failed to save file', error);
      });
    } catch (error) {
      reportFailure('Failed to save file', error);
    }
  }),
];

export const registerBuiltinWorkbenchCommands = (context: SurfaceActivationContext): void => {
  for (const definition of BUILTIN_WORKBENCH_COMMANDS) {
    context.contribute({
      id: `${BUILTIN_COMMANDS_EXTENSION_ID}.${definition.meta.commandId}`,
      kind: 'command',
      contractVersion: 1,
      supports: ['web', 'desktop', 'mobile', 'vscode'],
      placement: { slot: 'command-palette.primary', order: definition.meta.order },
      data: {
        commandId: definition.meta.commandId,
        titleKey: definition.meta.titleKey,
        ...(definition.meta.mobileTitleKey ? { mobileTitleKey: definition.meta.mobileTitleKey } : {}),
        icon: definition.meta.icon,
        keywords: definition.meta.keywords,
        order: definition.meta.order,
        ...(definition.meta.shortcutId ? { shortcutId: definition.meta.shortcutId } : {}),
      },
    }, definition.implementation);
  }
};
