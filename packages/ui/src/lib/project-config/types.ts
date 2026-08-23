import type { DraftStarterRef } from '@/lib/draftStarters';

export interface PiariumProjectRef {
  id: string;
  path: string;
}

export type PiariumProjectActionPlatform = 'macos' | 'linux' | 'windows';

export interface PiariumProjectAction {
  id: string;
  name: string;
  command: string;
  icon?: string | null;
  platforms?: PiariumProjectActionPlatform[];
  autoOpenUrl?: boolean;
  openUrl?: string;
  desktopOpenSshForward?: string;
}

export interface PiariumProjectActionsState {
  actions: PiariumProjectAction[];
  primaryActionId: string | null;
}

export interface PiariumProjectTodoItem {
  id: string;
  text: string;
  completed: boolean;
  createdAt: number;
}

export interface PiariumProjectPlanFileLink {
  id: string;
  path: string;
  createdAt: number;
}

export interface PiariumProjectPlanFile {
  title: string;
  body: string;
  raw: string;
  path: string;
}

export interface PiariumProjectNotesTodos {
  notes: string;
  todos: PiariumProjectTodoItem[];
}

export interface PiariumProjectContextData extends PiariumProjectNotesTodos {
  plans: PiariumProjectPlanFileLink[];
}

export interface PiariumProjectConfig extends Record<string, unknown> {
  projectPath?: string;
  setupWorktree?: string[];
  waitForWorktreeSetup?: boolean;
  projectNotes?: string;
  projectTodos?: PiariumProjectTodoItem[];
  projectPlanFiles?: PiariumProjectPlanFileLink[];
  projectActions?: PiariumProjectAction[];
  projectActionsPrimaryId?: string;
  draftStarters?: DraftStarterRef[];
}
