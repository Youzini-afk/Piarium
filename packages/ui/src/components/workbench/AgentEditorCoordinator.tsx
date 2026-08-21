import React from 'react';
import { toast } from '@/components/ui';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useDocumentRecord } from '@/lib/documents/hooks';
import { useWorkbenchWorkspaceId } from '@/lib/extensions/workbench-workspace';
import { sliceDocumentRange } from '@/lib/agent-editor/range';
import { recordHintsFromToolCall } from '@/lib/agent-editor/hints';
import { attachActiveEditorContext, attachEditorContext } from '@/lib/agent-editor/attach';
import { peekEditorSessionLink } from '@/lib/agent-editor/navigation';
import { registerWorkbenchCommand } from '@/lib/workbench/editors/commands';
import { registerWorkbenchMenuItem } from '@/lib/workbench/editors/menus';
import { setWorkbenchContextKey } from '@/lib/workbench/editors/context-keys';
import { activeEditorTab } from '@/lib/workbench/editors/groups';
import {
  peekEditorWorkbench,
  subscribeEditorWorkbench,
} from '@/lib/workbench/editors/session';
import { getWorkbenchProblems, showWorkbenchPanel } from '@/lib/workbench/editors/panels';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiEditorContextStore } from '@/stores/usePiEditorContextStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';

const ATTACH_ERROR_KEYS = {
  'missing-editor': 'workbench.attachment.missing-editor',
  'missing-selection': 'workbench.attachment.missing-selection',
  'missing-document': 'workbench.attachment.missing-document',
  'wrong-runtime': 'workbench.attachment.wrong-runtime',
  'no-session': 'workbench.attachment.no-session',
} as const satisfies Record<string, I18nKey>;

const OWNER = 'piarium.builtin.workbench';

const fileNameOf = (resourceId: string): string => resourceId.split('/').pop() || resourceId;

export const AgentEditorCoordinator: React.FC = () => {
  const { t } = useI18n();
  const workspaceId = useWorkbenchWorkspaceId();
  const directory = useDirectoryStore((state) => state.currentDirectory);
  const sessionId = usePiSessionStore((state) => state.currentSessionId);
  const runtimeKey = usePiSessionStore((state) => state.runtimeKey);
  const toolExecutions = usePiSessionStore((state) => (
    sessionId ? state.records[sessionId]?.toolExecutions : undefined
  ));
  const workbench = React.useSyncExternalStore(
    subscribeEditorWorkbench,
    () => (workspaceId ? peekEditorWorkbench(workspaceId) : undefined),
    () => undefined,
  );
  const tab = workbench ? activeEditorTab(workbench) : undefined;
  const identity = workspaceId && tab
    ? { workspaceId, resourceId: tab.resourceId }
    : undefined;
  const record = useDocumentRecord(identity);

  React.useEffect(() => {
    if (!tab || !workspaceId || !directory || !record) return;
    const hasRange = Boolean(tab.viewState.selectionStartLine && tab.viewState.selectionEndLine);
    const selection = hasRange
      ? {
        startLine: tab.viewState.selectionStartLine as number,
        startColumn: tab.viewState.selectionStartColumn ?? 1,
        endLine: tab.viewState.selectionEndLine as number,
        endColumn: tab.viewState.selectionEndColumn ?? 1,
        text: sliceDocumentRange(record.buffer, {
          startLine: tab.viewState.selectionStartLine as number,
          startColumn: tab.viewState.selectionStartColumn ?? 1,
          endLine: tab.viewState.selectionEndLine as number,
          endColumn: tab.viewState.selectionEndColumn ?? 1,
        }),
      }
      : null;
    usePiEditorContextStore.getState().setActiveEditorFile({
      fileName: fileNameOf(tab.resourceId),
      filePath: `${directory.replace(/\\/g, '/').replace(/\/$/, '')}/${tab.resourceId}`,
      fileSize: record.byteLength,
      relativePath: tab.resourceId,
      selection,
      dirty: record.dirty,
    });
    setWorkbenchContextKey('editorIsOpen', true);
    setWorkbenchContextKey('editorIsDirty', record.dirty);
    setWorkbenchContextKey('editorHasSelection', selection !== null);
  }, [directory, record, tab, workspaceId]);

  React.useEffect(() => {
    if (!sessionId || !workspaceId || !directory || !toolExecutions) return;
    for (const execution of Object.values(toolExecutions)) {
      recordHintsFromToolCall({
        runtimeKey,
        sessionId,
        toolCallId: execution.toolCallId,
        toolName: execution.name,
        args: execution.args,
        workspaceId,
        workspaceRoot: directory,
      });
    }
  }, [directory, runtimeKey, sessionId, toolExecutions, workspaceId]);

  React.useEffect(() => {
    const notify = (status: 'missing-editor' | 'missing-selection' | 'missing-document' | 'wrong-runtime' | 'no-session') => {
      toast.error(t(ATTACH_ERROR_KEYS[status]));
    };
    const attach = (kind: 'editor' | 'selection') => {
      if (!sessionId || !workspaceId || !directory) {
        notify('no-session');
        return;
      }
      const result = attachActiveEditorContext({
        sessionId,
        workspaceId,
        workspaceRoot: directory,
        kind,
      });
      if ('status' in result) notify(result.status);
    };
    const dispose = [
      registerWorkbenchCommand('piarium.editor.attachActiveFile', OWNER, () => attach('editor')),
      registerWorkbenchCommand('piarium.editor.attachSelection', OWNER, () => attach('selection')),
      registerWorkbenchCommand('piarium.editor.attachProblem', OWNER, () => {
        if (!sessionId || !workspaceId) {
          notify('no-session');
          return;
        }
        const problems = getWorkbenchProblems(workspaceId);
        const item = problems.status === 'ready' ? problems.items[0] : undefined;
        if (!item) {
          notify('missing-document');
          return;
        }
        const result = attachEditorContext({
          sessionId,
          workspaceId,
          resourceId: item.resourceId,
          kind: 'diagnostic',
          diagnosticMessage: item.message,
          ...(typeof item.line === 'number'
            ? {
              range: {
                startLine: item.line,
                startColumn: item.column ?? 1,
                endLine: item.line,
                endColumn: item.column ?? 1,
              },
            }
            : {}),
        });
        if ('status' in result) notify(result.status);
      }),
      registerWorkbenchCommand('piarium.editor.revealInSession', OWNER, () => {
        if (!workspaceId || !tab) return;
        const link = peekEditorSessionLink({ workspaceId, resourceId: tab.resourceId });
        if (!link?.entryId) return;
        void usePiSessionStore.getState().navigateSession(link.sessionId, link.entryId);
      }),
      registerWorkbenchCommand('piarium.editor.showChanges', OWNER, () => {
        if (workspaceId) showWorkbenchPanel(workspaceId, 'changes');
      }),
      registerWorkbenchMenuItem({
        id: 'piarium.editor.attachActiveFile',
        commandId: 'piarium.editor.attachActiveFile',
        group: 'editor/title',
        order: 20,
        when: { editorIsOpen: true },
      }),
    ];
    return () => {
      for (const close of dispose) close();
    };
  }, [directory, sessionId, t, tab, workspaceId]);

  return null;
};
