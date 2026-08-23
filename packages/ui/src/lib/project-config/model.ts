import type {
  PiariumProjectAction,
  PiariumProjectActionPlatform,
  PiariumProjectActionsState,
  PiariumProjectContextData,
  PiariumProjectNotesTodos,
  PiariumProjectPlanFileLink,
  PiariumProjectTodoItem,
} from './types';

export const PIARIUM_PROJECT_NOTES_MAX_LENGTH = 3000;
export const PIARIUM_PROJECT_TODO_TEXT_MAX_LENGTH = 120;
const PROJECT_ACTION_NAME_MAX_LENGTH = 80;
const PROJECT_ACTION_COMMAND_MAX_LENGTH = 4000;
const PROJECT_ACTION_OPEN_URL_MAX_LENGTH = 2000;
const PROJECT_ACTION_DESKTOP_FORWARD_MAX_LENGTH = 300;
const PROJECT_PLAN_TITLE_MAX_LENGTH = 160;
const ACTION_PLATFORM_SET = new Set<PiariumProjectActionPlatform>(['macos', 'linux', 'windows']);

const trimToMaxLength = (value: string, maxLength: number): string => (
  value.length <= maxLength ? value : value.slice(0, maxLength)
);

export const sanitizeProjectNotes = (value: unknown): string => (
  typeof value === 'string' ? trimToMaxLength(value, PIARIUM_PROJECT_NOTES_MAX_LENGTH) : ''
);

export const sanitizeProjectTodoItems = (value: unknown): PiariumProjectTodoItem[] => {
  if (!Array.isArray(value)) return [];
  const sanitized: PiariumProjectTodoItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const text = trimToMaxLength(
      typeof record.text === 'string' ? record.text.trim() : '',
      PIARIUM_PROJECT_TODO_TEXT_MAX_LENGTH,
    );
    if (!id || !text) continue;
    sanitized.push({
      id,
      text,
      completed: record.completed === true,
      createdAt: typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) && record.createdAt >= 0
        ? record.createdAt
        : Date.now(),
    });
  }
  return sanitized;
};

export const sanitizeProjectPlanFileLinks = (value: unknown): PiariumProjectPlanFileLink[] => {
  if (!Array.isArray(value)) return [];
  const sanitized: PiariumProjectPlanFileLink[] = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const path = typeof record.path === 'string' ? record.path.trim() : '';
    if (!id || !path || seenIds.has(id)) continue;
    seenIds.add(id);
    sanitized.push({
      id,
      path,
      createdAt: typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) && record.createdAt >= 0
        ? record.createdAt
        : Date.now(),
    });
  }
  return sanitized.sort((left, right) => right.createdAt - left.createdAt);
};

const sanitizeProjectActionPlatforms = (value: unknown): PiariumProjectActionPlatform[] => {
  if (!Array.isArray(value)) return [];
  const result: PiariumProjectActionPlatform[] = [];
  const seen = new Set<PiariumProjectActionPlatform>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const platform = entry.trim().toLowerCase() as PiariumProjectActionPlatform;
    if (!ACTION_PLATFORM_SET.has(platform) || seen.has(platform)) continue;
    seen.add(platform);
    result.push(platform);
  }
  return result;
};

export const sanitizeProjectActions = (value: unknown): PiariumProjectAction[] => {
  if (!Array.isArray(value)) return [];
  const result: PiariumProjectAction[] = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const name = trimToMaxLength(
      typeof record.name === 'string' ? record.name.trim() : '',
      PROJECT_ACTION_NAME_MAX_LENGTH,
    );
    const command = trimToMaxLength(
      typeof record.command === 'string' ? record.command.trim() : '',
      PROJECT_ACTION_COMMAND_MAX_LENGTH,
    );
    if (!id || !name || !command || seenIds.has(id)) continue;
    seenIds.add(id);
    const icon = typeof record.icon === 'string' ? record.icon.trim() : '';
    const openUrl = trimToMaxLength(
      typeof record.openUrl === 'string' ? record.openUrl.trim() : '',
      PROJECT_ACTION_OPEN_URL_MAX_LENGTH,
    );
    const desktopOpenSshForward = trimToMaxLength(
      typeof record.desktopOpenSshForward === 'string' ? record.desktopOpenSshForward.trim() : '',
      PROJECT_ACTION_DESKTOP_FORWARD_MAX_LENGTH,
    );
    const platforms = sanitizeProjectActionPlatforms(record.platforms);
    result.push({
      id,
      name,
      command,
      icon: icon || null,
      ...(record.autoOpenUrl === true ? { autoOpenUrl: true } : {}),
      ...(openUrl ? { openUrl } : {}),
      ...(desktopOpenSshForward ? { desktopOpenSshForward } : {}),
      ...(platforms.length > 0 ? { platforms } : {}),
    });
  }
  return result;
};

export const sanitizeProjectActionsState = (value: {
  actions?: unknown;
  primaryActionId?: unknown;
} | null | undefined): PiariumProjectActionsState => {
  const actions = sanitizeProjectActions(value?.actions);
  const candidate = typeof value?.primaryActionId === 'string' ? value.primaryActionId.trim() : '';
  return {
    actions,
    primaryActionId: candidate && actions.some((entry) => entry.id === candidate) ? candidate : null,
  };
};

export const sanitizeProjectNotesAndTodos = (value: {
  notes?: unknown;
  todos?: unknown;
} | null | undefined): PiariumProjectNotesTodos => ({
  notes: sanitizeProjectNotes(value?.notes),
  todos: sanitizeProjectTodoItems(value?.todos),
});

export const sanitizeProjectContextData = (value: {
  notes?: unknown;
  todos?: unknown;
  plans?: unknown;
} | null | undefined): PiariumProjectContextData => ({
  ...sanitizeProjectNotesAndTodos(value),
  plans: sanitizeProjectPlanFileLinks(value?.plans),
});

export const sanitizePlanTitle = (value: string): string => (
  trimToMaxLength(value.trim(), PROJECT_PLAN_TITLE_MAX_LENGTH)
);

export const slugifyPlanTitle = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[`*_#>[\](){}.!?,:;"']/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'plan';
};

export const formatProjectPlanMarkdown = (title: string, body: string): string => {
  const normalizedTitle = sanitizePlanTitle(title) || 'Plan';
  const normalizedBody = body.trim();
  return normalizedBody ? `# ${normalizedTitle}\n\n${normalizedBody}` : `# ${normalizedTitle}\n`;
};

export const parseProjectPlanMarkdown = (raw: string): { title: string; body: string } => {
  const normalized = (typeof raw === 'string' ? raw : '').replace(/\r\n?/g, '\n');
  const match = normalized.match(/^\s*#\s+(.+?)\s*(?:\n+|$)/);
  if (match) {
    return {
      title: sanitizePlanTitle(match[1]) || 'Plan',
      body: normalized.slice(match[0].length).replace(/^\n+/, ''),
    };
  }
  const firstNonEmptyLine = normalized.split('\n').map((line) => line.trim()).find(Boolean) || 'Plan';
  return {
    title: sanitizePlanTitle(firstNonEmptyLine.replace(/^#+\s*/, '')) || 'Plan',
    body: normalized.trim(),
  };
};
