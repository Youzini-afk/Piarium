import { sanitizeStarterRefs, type DraftStarterRef } from '@/lib/draftStarters';
import {
  formatProjectPlanMarkdown,
  parseProjectPlanMarkdown,
  VARIN_PROJECT_NOTES_MAX_LENGTH,
  VARIN_PROJECT_TODO_TEXT_MAX_LENGTH,
  sanitizePlanTitle,
  sanitizeProjectActionsState,
  sanitizeProjectContextData,
  sanitizeProjectNotesAndTodos,
  sanitizeProjectPlanFileLinks,
  slugifyPlanTitle,
} from './model';
import { varinProjectConfigStore } from './storage';
import type {
  VarinProjectActionsState,
  VarinProjectContextData,
  VarinProjectNotesTodos,
  VarinProjectPlanFile,
  VarinProjectPlanFileLink,
  VarinProjectRef,
} from './types';

export {
  parseProjectPlanMarkdown,
  VARIN_PROJECT_NOTES_MAX_LENGTH,
  VARIN_PROJECT_TODO_TEXT_MAX_LENGTH,
};
export { VarinProjectConfigError } from './storage';
export type * from './types';

const createProjectPlanId = (): string => (
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
);

export const getWorktreeSetupCommands = async (project: VarinProjectRef): Promise<string[]> => {
  const value = (await varinProjectConfigStore.read(project)).setupWorktree;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
};

export const saveWorktreeSetupCommands = async (
  project: VarinProjectRef,
  commands: string[],
): Promise<boolean> => varinProjectConfigStore.update(project, {
  setupWorktree: commands.filter((command) => command.trim().length > 0),
});

export const getWorktreeSetupWaitEnabled = async (project: VarinProjectRef): Promise<boolean> => (
  (await varinProjectConfigStore.read(project)).waitForWorktreeSetup === true
);

export const saveWorktreeSetupWaitEnabled = async (
  project: VarinProjectRef,
  enabled: boolean,
): Promise<boolean> => varinProjectConfigStore.update(project, { waitForWorktreeSetup: enabled });

export const getProjectDraftStarters = async (project: VarinProjectRef): Promise<DraftStarterRef[]> => (
  sanitizeStarterRefs((await varinProjectConfigStore.read(project)).draftStarters)
);

export const saveProjectDraftStarters = async (
  project: VarinProjectRef,
  starters: DraftStarterRef[],
): Promise<boolean> => varinProjectConfigStore.update(project, { draftStarters: sanitizeStarterRefs(starters) });

export const getProjectNotesAndTodos = async (
  project: VarinProjectRef,
): Promise<VarinProjectNotesTodos> => {
  const config = await varinProjectConfigStore.read(project);
  return sanitizeProjectNotesAndTodos({ notes: config.projectNotes, todos: config.projectTodos });
};

export const saveProjectNotesAndTodos = async (
  project: VarinProjectRef,
  value: VarinProjectNotesTodos,
): Promise<boolean> => {
  const sanitized = sanitizeProjectNotesAndTodos(value);
  return varinProjectConfigStore.update(project, {
    projectNotes: sanitized.notes,
    projectTodos: sanitized.todos,
  });
};

export const getProjectContextData = async (
  project: VarinProjectRef,
): Promise<VarinProjectContextData> => {
  const config = await varinProjectConfigStore.read(project);
  return sanitizeProjectContextData({
    notes: config.projectNotes,
    todos: config.projectTodos,
    plans: config.projectPlanFiles,
  });
};

export const readProjectPlanFile = async (
  project: VarinProjectRef,
  path: string,
): Promise<VarinProjectPlanFile | null> => {
  const trimmedPath = typeof path === 'string' ? path.trim() : '';
  if (!trimmedPath) return null;
  const raw = await varinProjectConfigStore.readText(project, trimmedPath);
  if (raw === null) return null;
  const parsed = parseProjectPlanMarkdown(raw);
  return { ...parsed, raw, path: trimmedPath };
};

export const deleteProjectPlanFile = async (
  project: VarinProjectRef,
  planId: string,
): Promise<boolean> => {
  const id = typeof planId === 'string' ? planId.trim() : '';
  if (!id) return false;
  const selected: { value: VarinProjectPlanFileLink | null } = { value: null };
  const removed = await varinProjectConfigStore.mutate(project, (config) => {
    const existing = sanitizeProjectPlanFileLinks(config.projectPlanFiles);
    selected.value = existing.find((entry) => entry.id === id) ?? null;
    return selected.value ? { projectPlanFiles: existing.filter((entry) => entry.id !== id) } : null;
  });
  const target = selected.value;
  if (!removed || !target) return false;
  if (await varinProjectConfigStore.deleteText(project, target.path)) return true;
  await varinProjectConfigStore.mutate(project, (config) => {
    const current = sanitizeProjectPlanFileLinks(config.projectPlanFiles);
    return current.some((entry) => entry.id === target.id)
      ? null
      : { projectPlanFiles: sanitizeProjectPlanFileLinks([target, ...current]) };
  }).catch(() => false);
  return false;
};

export const importProjectPlanFileFromContent = async (
  project: VarinProjectRef,
  content: string,
  fallbackTitle?: string,
): Promise<VarinProjectPlanFileLink | null> => {
  const raw = typeof content === 'string' ? content : '';
  if (!raw.trim()) return null;
  const parsed = parseProjectPlanMarkdown(raw);
  return createProjectPlanFile(project, {
    title: parsed.title || sanitizePlanTitle(fallbackTitle ?? '') || 'Plan',
    body: parsed.body,
  });
};

export const createProjectPlanFile = async (
  project: VarinProjectRef,
  value: { title: string; body: string },
): Promise<VarinProjectPlanFileLink | null> => {
  const paths = await varinProjectConfigStore.getPaths(project);
  const title = sanitizePlanTitle(value.title) || 'Plan';
  const createdAt = Date.now();
  const id = createProjectPlanId();
  const filePath = `${paths.canonicalDirectory}/plans/${createdAt}-${slugifyPlanTitle(title)}.md`;
  if (!await varinProjectConfigStore.writeText(project, filePath, formatProjectPlanMarkdown(title, value.body))) {
    return null;
  }
  const nextEntry = { id, path: filePath, createdAt };
  if (!await varinProjectConfigStore.mutate(project, (config) => ({
    projectPlanFiles: sanitizeProjectPlanFileLinks([
      nextEntry,
      ...sanitizeProjectPlanFileLinks(config.projectPlanFiles),
    ]),
  }))) {
    await varinProjectConfigStore.deleteText(project, filePath).catch(() => false);
    return null;
  }
  return nextEntry;
};

export const getProjectActionsState = async (
  project: VarinProjectRef,
): Promise<VarinProjectActionsState> => {
  const config = await varinProjectConfigStore.read(project);
  return sanitizeProjectActionsState({
    actions: config.projectActions,
    primaryActionId: config.projectActionsPrimaryId,
  });
};

export const saveProjectActionsState = async (
  project: VarinProjectRef,
  value: VarinProjectActionsState,
): Promise<boolean> => {
  const sanitized = sanitizeProjectActionsState(value);
  return varinProjectConfigStore.update(project, {
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
