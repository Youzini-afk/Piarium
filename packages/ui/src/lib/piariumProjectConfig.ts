import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';

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

const readConfig = async (project: PiariumProjectRef): Promise<PiariumProjectConfig> => {
  const files = getRegisteredRuntimeAPIs()?.files;
  const target = configPath(project);
  if (!files?.readFile || !target) return {};
  const readFile = files.readFile.bind(files);
  try {
    const parsed = JSON.parse((await readFile(target)).content) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as PiariumProjectConfig
      : {};
  } catch {
    return {};
  }
};

const writeConfig = async (project: PiariumProjectRef, patch: Partial<PiariumProjectConfig>): Promise<boolean> => {
  const files = getRegisteredRuntimeAPIs()?.files;
  const target = configPath(project);
  if (!files?.writeFile || !target) return false;
  const writeFile = files.writeFile.bind(files);
  const next = { ...await readConfig(project), ...patch, projectPath: normalize(project.path) };
  await files.createDirectory(target.slice(0, target.lastIndexOf('/')));
  return (await writeFile(target, `${JSON.stringify(next, null, 2)}\n`)).success;
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
