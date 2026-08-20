import React from 'react';
import { toast } from '@/components/ui';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useWorkbenchWorkspaceId } from '@/lib/extensions/workbench-workspace';
import { attachEditorContext } from '@/lib/agent-editor/attach';
import { peekLastStackFrame, peekLastTestFailure } from '@/lib/run-debug/session';
import { registerWorkbenchCommand } from '@/lib/workbench/editors/commands';
import { activeEditorTab } from '@/lib/workbench/editors/groups';
import { peekEditorWorkbench, subscribeEditorWorkbench } from '@/lib/workbench/editors/session';
import { usePiSessionStore } from '@/stores/usePiSessionStore';

const OWNER = 'piarium.builtin.workbench';

const ATTACH_ERROR_KEYS = {
  'missing-test': 'workbench.attachment.missing-test',
  'missing-stack': 'workbench.attachment.missing-stack',
  'no-session': 'workbench.attachment.no-session',
  'missing-document': 'workbench.attachment.missing-document',
  'wrong-runtime': 'workbench.attachment.wrong-runtime',
} as const satisfies Record<string, I18nKey>;

export const RunDebugCoordinator: React.FC = () => {
  const { t } = useI18n();
  const apis = useRuntimeAPIs();
  const workspaceId = useWorkbenchWorkspaceId();
  const sessionId = usePiSessionStore((state) => state.currentSessionId);
  const workbench = React.useSyncExternalStore(
    subscribeEditorWorkbench,
    () => (workspaceId ? peekEditorWorkbench(workspaceId) : undefined),
    () => undefined,
  );
  const tab = workbench ? activeEditorTab(workbench) : undefined;

  React.useEffect(() => {
    const notify = (status: keyof typeof ATTACH_ERROR_KEYS) => {
      toast.error(t(ATTACH_ERROR_KEYS[status]));
    };
    const dispose = [
      registerWorkbenchCommand('workbench.action.debug.start', OWNER, () => {
        if (!workspaceId) return;
        void apis.debug.start({
          workspaceId,
          ...(tab?.resourceId ? { program: tab.resourceId, languageId: 'javascript' } : {}),
        });
      }),
      registerWorkbenchCommand('workbench.action.debug.stop', OWNER, () => {
        if (!workspaceId) return;
        void apis.debug.stop({ workspaceId });
      }),
      registerWorkbenchCommand('workbench.action.debug.continue', OWNER, () => {
        if (!workspaceId) return;
        void apis.debug.continue({ workspaceId });
      }),
      registerWorkbenchCommand('workbench.action.debug.pause', OWNER, () => {
        if (!workspaceId) return;
        void apis.debug.pause({ workspaceId });
      }),
      registerWorkbenchCommand('workbench.action.debug.stepOver', OWNER, () => {
        if (!workspaceId) return;
        void apis.debug.stepOver({ workspaceId });
      }),
      registerWorkbenchCommand('workbench.action.debug.stepInto', OWNER, () => {
        if (!workspaceId) return;
        void apis.debug.stepIn({ workspaceId });
      }),
      registerWorkbenchCommand('workbench.action.debug.stepOut', OWNER, () => {
        if (!workspaceId) return;
        void apis.debug.stepOut({ workspaceId });
      }),
      registerWorkbenchCommand('workbench.action.test.run', OWNER, () => {
        if (!workspaceId) return;
        void apis.tests.run({ workspaceId });
      }),
      registerWorkbenchCommand('workbench.action.test.discover', OWNER, () => {
        if (!workspaceId) return;
        void apis.tests.discover({ workspaceId });
      }),
      registerWorkbenchCommand('editor.debug.toggleBreakpoint', OWNER, () => {
        if (!workspaceId || !tab) return;
        const line = tab.viewState.cursorLine ?? 1;
        void apis.debug.listBreakpoints(workspaceId).then((listed) => {
          const existing = listed.breakpoints.filter((item) => item.resourceId === tab.resourceId).map((item) => item.line);
          const next = existing.includes(line) ? existing.filter((item) => item !== line) : [...existing, line];
          return apis.debug.setBreakpoints({ workspaceId, resourceId: tab.resourceId, lines: next });
        });
      }),
      registerWorkbenchCommand('piarium.editor.attachTestFailure', OWNER, () => {
        if (!sessionId || !workspaceId) {
          notify('no-session');
          return;
        }
        const failure = peekLastTestFailure(workspaceId);
        if (!failure) {
          notify('missing-test');
          return;
        }
        const result = attachEditorContext({
          sessionId,
          workspaceId,
          resourceId: failure.resourceId ?? failure.id,
          kind: 'test-failure',
          diagnosticMessage: failure.message ?? failure.label,
          ...(typeof failure.line === 'number'
            ? {
              range: {
                startLine: failure.line,
                startColumn: 1,
                endLine: failure.line,
                endColumn: 1,
              },
            }
            : {}),
          ...(failure.stack ? { text: failure.stack } : {}),
          label: failure.label,
        });
        if ('status' in result && (result.status === 'wrong-runtime' || result.status === 'missing-document')) {
          notify(result.status);
        }
      }),
      registerWorkbenchCommand('piarium.editor.attachStackFrame', OWNER, () => {
        if (!sessionId || !workspaceId) {
          notify('no-session');
          return;
        }
        const frame = peekLastStackFrame(workspaceId);
        if (!frame) {
          notify('missing-stack');
          return;
        }
        const result = attachEditorContext({
          sessionId,
          workspaceId,
          resourceId: frame.resourceId ?? tab?.resourceId ?? 'stack',
          kind: 'stack',
          diagnosticMessage: `${frame.name}:${frame.line}`,
          range: {
            startLine: frame.line,
            startColumn: frame.column,
            endLine: frame.line,
            endColumn: frame.column,
          },
          label: frame.name,
        });
        if ('status' in result && (result.status === 'wrong-runtime' || result.status === 'missing-document')) {
          notify(result.status);
        }
      }),
    ];
    return () => {
      for (const close of dispose) close();
    };
  }, [apis.debug, apis.tests, sessionId, t, tab, workspaceId]);

  return null;
};
