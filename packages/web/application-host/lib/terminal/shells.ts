const TERMINAL_SHELL_IDS = ['bash', 'zsh', 'sh', 'fish', 'pwsh', 'powershell', 'cmd', 'dash', 'ksh', 'nu'] as const;
export type TerminalShellId = typeof TERMINAL_SHELL_IDS[number];
export type TerminalShellPreference = 'auto' | TerminalShellId;
const TERMINAL_SHELL_ID_SET = new Set<string>(TERMINAL_SHELL_IDS);

export const normalizeTerminalShell = (value: unknown): TerminalShellPreference | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized === 'auto' || TERMINAL_SHELL_ID_SET.has(normalized)
    ? normalized as TerminalShellPreference
    : null;
};

const shellIdFromPath = (value: unknown): TerminalShellId | null => {
  const filename = String(value || '').replace(/\\/g, '/').split('/').pop()?.toLowerCase() || '';
  const id = filename.endsWith('.exe') ? filename.slice(0, -4) : filename;
  return TERMINAL_SHELL_ID_SET.has(id) ? id as TerminalShellId : null;
};

const SHELL_LABELS: Partial<Record<TerminalShellId, string>> = { pwsh: 'PowerShell', powershell: 'Windows PowerShell', cmd: 'Command Prompt' };
const shellLabel = (id: TerminalShellId): string => SHELL_LABELS[id] ?? id;

export const getTerminalShellLoginArgs = (executable: unknown, platform: NodeJS.Platform = process.platform): string[] | null => {
  const id = shellIdFromPath(executable);
  if (id === 'bash' || id === 'zsh' || id === 'ksh') return ['-l'];
  if (id === 'fish' || id === 'nu') return ['--login'];
  if (id === 'pwsh' && platform !== 'win32') return ['-Login'];
  return null;
};

export interface TerminalShellResolverDependencies {
  buildAugmentedPath?: (() => string) | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  fs: { promises: { readFile(path: string, encoding: 'utf8'): Promise<string> } };
  isExecutable(path: string): boolean;
  path: { join(...parts: string[]): string };
  platform?: NodeJS.Platform | undefined;
  searchPathFor(name: string, searchPath: string): string | null;
}

export interface TerminalShellDescriptor {
  executable: string | null;
  id: TerminalShellPreference;
  name: string;
  supportsLogin: boolean;
}

export const createTerminalShellResolver = ({ fs, path, searchPathFor, isExecutable, buildAugmentedPath = () => env.PATH || '', platform = process.platform, env = process.env }: TerminalShellResolverDependencies) => {
  const resolveExecutable = (candidate: unknown): string | null => {
    if (!candidate) return null;
    const value = String(candidate);
    const found = value.includes('/') || value.includes('\\') ? value : searchPathFor(value, buildAugmentedPath());
    if (found && isExecutable(found)) return found;
    return isExecutable(value) ? value : null;
  };

  const defaultCandidates = (): Array<string | undefined> => platform === 'win32'
    ? [
        env.PIARIUM_TERMINAL_SHELL,
        env.SHELL,
        env.ComSpec,
        path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        'pwsh.exe',
        'powershell.exe',
        'cmd.exe',
      ]
    : [env.PIARIUM_TERMINAL_SHELL, env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh', 'zsh', 'bash', 'sh'];

  const resolveCandidates = (candidates: unknown[]): string[] => {
    const seen = new Set<string>();
    return candidates
      .map(resolveExecutable)
      .filter((candidate): candidate is string => {
        if (!candidate || seen.has(candidate)) return false;
        seen.add(candidate);
        return true;
      });
  };

  const list = async (): Promise<TerminalShellDescriptor[]> => {
    let configuredShells: string[] = [];
    if (platform !== 'win32') {
      try {
        const contents = await fs.promises.readFile('/etc/shells', 'utf8');
        configuredShells = contents
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'));
      } catch {
        // PATH and platform defaults below remain authoritative fallbacks.
      }
    }

    const candidates = platform === 'win32'
      ? [...defaultCandidates(), ...TERMINAL_SHELL_IDS]
      : [env.PIARIUM_TERMINAL_SHELL, env.SHELL, ...configuredShells, ...TERMINAL_SHELL_IDS, '/bin/zsh', '/bin/bash', '/bin/sh'];
    const autoExecutable = resolveCandidates(defaultCandidates())[0] ?? null;
    const byId = new Map<TerminalShellPreference, TerminalShellDescriptor>([
      ['auto', {
        id: 'auto',
        name: 'Auto',
        executable: autoExecutable,
        supportsLogin: Boolean(autoExecutable && getTerminalShellLoginArgs(autoExecutable, platform)),
      }],
    ]);
    for (const executable of resolveCandidates(candidates)) {
      const id = shellIdFromPath(executable);
      if (id && !byId.has(id)) {
        byId.set(id, { id, name: shellLabel(id), executable, supportsLogin: Boolean(getTerminalShellLoginArgs(executable, platform)) });
      }
    }
    return [...byId.values()];
  };

  const resolve = async (preference: unknown): Promise<{ id: TerminalShellPreference; executables: string[] }> => {
    const normalized = normalizeTerminalShell(preference ?? 'auto');
    if (!normalized) throw new Error('Invalid terminal shell');
    if (normalized === 'auto') return { id: 'auto', executables: resolveCandidates(defaultCandidates()) };
    const selected = (await list()).find((shell) => shell.id === normalized);
    if (!selected) throw new Error(`Terminal shell "${normalized}" is not available`);
    return { id: selected.id, executables: selected.executable ? [selected.executable] : [] };
  };

  return { list, resolve };
};
