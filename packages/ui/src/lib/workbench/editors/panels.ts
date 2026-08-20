import type {
  WorkbenchOutputSnapshot,
  WorkbenchPanelId,
  WorkbenchPanelLayout,
  WorkbenchProblemsSnapshot,
} from './types';

type PanelSession = {
  layout: WorkbenchPanelLayout;
  problems: WorkbenchProblemsSnapshot;
  output: WorkbenchOutputSnapshot;
};

const sessions = new Map<string, PanelSession>();
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

const defaultLayout = (workspaceId: string): WorkbenchPanelLayout => ({
  workspaceId,
  visible: false,
  activePanelId: 'terminal',
  size: 0.3,
});

const EMPTY_PROBLEMS: WorkbenchProblemsSnapshot = { status: 'empty' };
const EMPTY_OUTPUT: WorkbenchOutputSnapshot = { status: 'empty' };

const getSession = (workspaceId: string): PanelSession => {
  const existing = sessions.get(workspaceId);
  if (existing) return existing;
  const created: PanelSession = {
    layout: defaultLayout(workspaceId),
    problems: { status: 'empty' },
    output: { status: 'empty' },
  };
  sessions.set(workspaceId, created);
  return created;
};

export const subscribeWorkbenchPanels = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const peekWorkbenchPanelLayout = (workspaceId: string | undefined): WorkbenchPanelLayout | undefined => (
  workspaceId ? sessions.get(workspaceId)?.layout : undefined
);

export const getWorkbenchPanelLayout = (workspaceId: string): WorkbenchPanelLayout => getSession(workspaceId).layout;

export const setWorkbenchPanelLayout = (
  workspaceId: string,
  patch: Partial<Omit<WorkbenchPanelLayout, 'workspaceId'>>,
): WorkbenchPanelLayout => {
  const session = getSession(workspaceId);
  const next = { ...session.layout, ...patch, workspaceId };
  if (
    next.visible === session.layout.visible
    && next.activePanelId === session.layout.activePanelId
    && next.size === session.layout.size
  ) {
    return session.layout;
  }
  session.layout = next;
  emit();
  return next;
};

export const showWorkbenchPanel = (workspaceId: string, panelId: WorkbenchPanelId): WorkbenchPanelLayout => (
  setWorkbenchPanelLayout(workspaceId, { visible: true, activePanelId: panelId })
);

export const hideWorkbenchPanel = (workspaceId: string): WorkbenchPanelLayout => (
  setWorkbenchPanelLayout(workspaceId, { visible: false })
);

export const getWorkbenchProblems = (workspaceId: string): WorkbenchProblemsSnapshot => (
  sessions.get(workspaceId)?.problems ?? EMPTY_PROBLEMS
);

export const setWorkbenchProblems = (workspaceId: string, snapshot: WorkbenchProblemsSnapshot): void => {
  const session = getSession(workspaceId);
  session.problems = snapshot;
  emit();
};

export const getWorkbenchOutput = (workspaceId: string): WorkbenchOutputSnapshot => (
  sessions.get(workspaceId)?.output ?? EMPTY_OUTPUT
);

export const setWorkbenchOutput = (workspaceId: string, snapshot: WorkbenchOutputSnapshot): void => {
  const session = getSession(workspaceId);
  session.output = snapshot;
  emit();
};

export const resetWorkbenchPanelsForRuntimeSwitch = (): void => {
  sessions.clear();
  emit();
};
