import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { pickWorkspaceRoot } from './documents/path';
import { readWorkspaceTextFile, writeWorkspaceTextFile } from './documents/workspace-text';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

export interface PiariumProjectRef {
  id: string;
  path: string;
}

interface PiariumProjectConfig {
  projectPath?: string;
  setupWorktree?: string[];
  waitForWorktreeSetup?: boolean;
}

const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
const join = (base: string, ...segments: string[]): string => (
  [normalize(base), ...segments.map((segment) => segment.replace(/^\/+|\/+$/g, ''))]
    .filter(Boolean)
    .join('/')
    .replace(/^\/\//, '/')
);

const getUserHome = (): string => {
  if (typeof window === 'undefined') return '';
  const value = (window as typeof window & { __PIARIUM_HOME__?: unknown }).__PIARIUM_HOME__;
  return typeof value === 'string' ? value.trim() : '';
};

const configPath = (project: PiariumProjectRef): string => {
  const home = getUserHome();
  return home ? join(home, '.config', 'piarium', 'projects', `${encodeURIComponent(project.id)}.json`) : '';
};

const workspaceAccess = async (target: string) => {
  const apis = getRegisteredRuntimeAPIs();
  if (!apis?.documents || !target) return null;
  const home = await apis.files.getHomeDirectory().catch(() => getUserHome());
  const current = useDirectoryStore.getState().currentDirectory;
  const root = pickWorkspaceRoot(target, [home, current]);
  if (!root) return null;
  return { documents: apis.documents, files: apis.files, root };
};

const readConfig = async (project: PiariumProjectRef): Promise<PiariumProjectConfig> => {
  const target = configPath(project);
  const access = await workspaceAccess(target);
  if (!access) return {};
  try {
    const raw = await readWorkspaceTextFile(access.documents, access.root, target);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as PiariumProjectConfig
      : {};
  } catch {
    return {};
  }
};

const writeConfig = async (project: PiariumProjectRef, patch: Partial<PiariumProjectConfig>): Promise<boolean> => {
  const target = configPath(project);
  const access = await workspaceAccess(target);
  if (!access) return false;
  const next = { ...await readConfig(project), ...patch, projectPath: normalize(project.path) };
  const parent = target.slice(0, target.lastIndexOf('/'));
  await access.files.createDirectory(parent);
  return writeWorkspaceTextFile(access.documents, access.root, target, `${JSON.stringify(next, null, 2)}\n`);
};

export const getWorktreeSetupCommands = async (project: PiariumProjectRef): Promise<string[]> => {
  const commands = (await readConfig(project)).setupWorktree;
  return Array.isArray(commands) ? commands.filter((command): command is string => typeof command === 'string') : [];
};

export const saveWorktreeSetupCommands = async (
  project: PiariumProjectRef,
  commands: string[],
): Promise<boolean> => writeConfig(project, { setupWorktree: commands.filter((command) => command.trim()) });

export const getWorktreeSetupWaitEnabled = async (project: PiariumProjectRef): Promise<boolean> => (
  (await readConfig(project)).waitForWorktreeSetup === true
);

export const saveWorktreeSetupWaitEnabled = async (
  project: PiariumProjectRef,
  enabled: boolean,
): Promise<boolean> => writeConfig(project, { waitForWorktreeSetup: enabled });

export const substituteProjectCommandVariables = (command: string, projectPath: string): string => (
  command
    .replace(/\$ROOT_PROJECT_PATH/g, projectPath)
    .replace(/\$\{ROOT_PROJECT_PATH\}/g, projectPath)
    .replace(/\$ROOT_WORKTREE_PATH/g, projectPath)
    .replace(/\$\{ROOT_WORKTREE_PATH\}/g, projectPath)
);
