import { sanitizeStarterRefs, type DraftStarterRef } from '@/lib/draftStarters';
import {
  formatProjectPlanMarkdown,
  parseProjectPlanMarkdown,
  PIARIUM_PROJECT_NOTES_MAX_LENGTH,
  PIARIUM_PROJECT_TODO_TEXT_MAX_LENGTH,
  sanitizePlanTitle,
  sanitizeProjectActionsState,
  sanitizeProjectContextData,
  sanitizeProjectNotesAndTodos,
  sanitizeProjectPlanFileLinks,
  slugifyPlanTitle,
} from './model';
import { piariumProjectConfigStore } from './storage';
import type {
  PiariumProjectActionsState,
  PiariumProjectContextData,
  PiariumProjectNotesTodos,
  PiariumProjectPlanFile,
  PiariumProjectPlanFileLink,
  PiariumProjectRef,
} from './types';

export {
  parseProjectPlanMarkdown,
  PIARIUM_PROJECT_NOTES_MAX_LENGTH,
  PIARIUM_PROJECT_TODO_TEXT_MAX_LENGTH,
};
export { PiariumProjectConfigError } from './storage';
export type * from './types';

const createProjectPlanId = (): string => (
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
);

export const getWorktreeSetupCommands = async (project: PiariumProjectRef): Promise<string[]> => {
  const value = (await piariumProjectConfigStore.read(project)).setupWorktree;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
};

export const saveWorktreeSetupCommands = async (
  project: PiariumProjectRef,
  commands: string[],
): Promise<boolean> => piariumProjectConfigStore.update(project, {
  setupWorktree: commands.filter((command) => command.trim().length > 0),
});

export const getWorktreeSetupWaitEnabled = async (project: PiariumProjectRef): Promise<boolean> => (
  (await piariumProjectConfigStore.read(project)).waitForWorktreeSetup === true
);

export const saveWorktreeSetupWaitEnabled = async (
  project: PiariumProjectRef,
  enabled: boolean,
): Promise<boolean> => piariumProjectConfigStore.update(project, { waitForWorktreeSetup: enabled });

export const getProjectDraftStarters = async (project: PiariumProjectRef): Promise<DraftStarterRef[]> => (
  sanitizeStarterRefs((await piariumProjectConfigStore.read(project)).draftStarters)
);

export const saveProjectDraftStarters = async (
  project: PiariumProjectRef,
  starters: DraftStarterRef[],
): Promise<boolean> => piariumProjectConfigStore.update(project, { draftStarters: sanitizeStarterRefs(starters) });

export const getProjectNotesAndTodos = async (
  project: PiariumProjectRef,
): Promise<PiariumProjectNotesTodos> => {
  const config = await piariumProjectConfigStore.read(project);
  return sanitizeProjectNotesAndTodos({ notes: config.projectNotes, todos: config.projectTodos });
};

export const saveProjectNotesAndTodos = async (
  project: PiariumProjectRef,
  value: PiariumProjectNotesTodos,
): Promise<boolean> => {
  const sanitized = sanitizeProjectNotesAndTodos(value);
  return piariumProjectConfigStore.update(project, {
    projectNotes: sanitized.notes,
    projectTodos: sanitized.todos,
  });
};

export const getProjectContextData = async (
  project: PiariumProjectRef,
): Promise<PiariumProjectContextData> => {
  const config = await piariumProjectConfigStore.read(project);
  return sanitizeProjectContextData({
    notes: config.projectNotes,
    todos: config.projectTodos,
    plans: config.projectPlanFiles,
  });
};

export const readProjectPlanFile = async (
  project: PiariumProjectRef,
  path: string,
): Promise<PiariumProjectPlanFile | null> => {
  const trimmedPath = typeof path === 'string' ? path.trim() : '';
  if (!trimmedPath) return null;
  const raw = await piariumProjectConfigStore.readText(project, trimmedPath);
  if (raw === null) return null;
  const parsed = parseProjectPlanMarkdown(raw);
  return { ...parsed, raw, path: trimmedPath };
};

export const deleteProjectPlanFile = async (
  project: PiariumProjectRef,
  planId: string,
): Promise<boolean> => {
  const id = typeof planId === 'string' ? planId.trim() : '';
  if (!id) return false;
  const selected: { value: PiariumProjectPlanFileLink | null } = { value: null };
  const removed = await piariumProjectConfigStore.mutate(project, (config) => {
    const existing = sanitizeProjectPlanFileLinks(config.projectPlanFiles);
    selected.value = existing.find((entry) => entry.id === id) ?? null;
    return selected.value ? { projectPlanFiles: existing.filter((entry) => entry.id !== id) } : null;
  });
  const target = selected.value;
  if (!removed || !target) return false;
  if (await piariumProjectConfigStore.deleteText(project, target.path)) return true;
  await piariumProjectConfigStore.mutate(project, (config) => {
    const current = sanitizeProjectPlanFileLinks(config.projectPlanFiles);
    return current.some((entry) => entry.id === target.id)
      ? null
      : { projectPlanFiles: sanitizeProjectPlanFileLinks([target, ...current]) };
  }).catch(() => false);
  return false;
};

export const importProjectPlanFileFromContent = async (
  project: PiariumProjectRef,
  content: string,
  fallbackTitle?: string,
): Promise<PiariumProjectPlanFileLink | null> => {
  const raw = typeof content === 'string' ? content : '';
  if (!raw.trim()) return null;
  const parsed = parseProjectPlanMarkdown(raw);
  return createProjectPlanFile(project, {
    title: parsed.title || sanitizePlanTitle(fallbackTitle ?? '') || 'Plan',
    body: parsed.body,
  });
};

export const createProjectPlanFile = async (
  project: PiariumProjectRef,
  value: { title: string; body: string },
): Promise<PiariumProjectPlanFileLink | null> => {
  const paths = await piariumProjectConfigStore.getPaths(project);
  const title = sanitizePlanTitle(value.title) || 'Plan';
  const createdAt = Date.now();
  const id = createProjectPlanId();
  const filePath = `${paths.canonicalDirectory}/plans/${createdAt}-${slugifyPlanTitle(title)}.md`;
  if (!await piariumProjectConfigStore.writeText(project, filePath, formatProjectPlanMarkdown(title, value.body))) {
    return null;
  }
  const nextEntry = { id, path: filePath, createdAt };
  if (!await piariumProjectConfigStore.mutate(project, (config) => ({
    projectPlanFiles: sanitizeProjectPlanFileLinks([
      nextEntry,
      ...sanitizeProjectPlanFileLinks(config.projectPlanFiles),
    ]),
  }))) {
    await piariumProjectConfigStore.deleteText(project, filePath).catch(() => false);
    return null;
  }
  return nextEntry;
};

export const getProjectActionsState = async (
  project: PiariumProjectRef,
): Promise<PiariumProjectActionsState> => {
  const config = await piariumProjectConfigStore.read(project);
  return sanitizeProjectActionsState({
    actions: config.projectActions,
    primaryActionId: config.projectActionsPrimaryId,
  });
};

export const saveProjectActionsState = async (
  project: PiariumProjectRef,
  value: PiariumProjectActionsState,
): Promise<boolean> => {
  const sanitized = sanitizeProjectActionsState(value);
  return piariumProjectConfigStore.update(project, {
    projectActions: sanitized.actions,
    projectActionsPrimaryId: sanitized.primaryActionId ?? undefined,
  });
};

export const substituteProjectCommandVariables = (command: string, projectPath: string): string => (
  command
    .replace(/\$ROOT_PROJECT_PATH/g, projectPath)
    .replace(/\$\{ROOT_PROJECT_PATH\}/g, projectPath)
    .replace(/\$ROOT_WORKTREE_PATH/g, projectPath)
    .replace(/\$\{ROOT_WORKTREE_PATH\}/g, projectPath)
);

export const substituteCommandVariables = (
  command: string,
  variables: { rootWorktreePath: string },
): string => substituteProjectCommandVariables(command, variables.rootWorktreePath);
