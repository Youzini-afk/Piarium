import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const AUTOSTART_FILE_NAME = 'piarium.desktop';

interface LinuxAutostartPathsOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

interface LinuxLaunchOptions extends LinuxAutostartPathsOptions {
  execPath?: string;
}

interface LinuxAutostartEntryOptions extends LinuxLaunchOptions {
  appName?: string;
  backgroundArg?: string;
  executable?: string;
}

interface SetLinuxAutostartOptions extends LinuxAutostartEntryOptions {
  enabled: boolean;
}

export const resolveLinuxAutostartDirectory = ({
  env = process.env,
  homeDir = os.homedir(),
}: LinuxAutostartPathsOptions = {}): string => {
  const configHome = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME.trim()
    : path.join(homeDir || os.homedir(), '.config');
  return path.join(configHome, 'autostart');
};

export const resolveLinuxAutostartFilePath = (options: LinuxAutostartPathsOptions = {}): string =>
  path.join(resolveLinuxAutostartDirectory(options), AUTOSTART_FILE_NAME);

export const resolveLinuxLaunchExecutable = ({
  env = process.env,
  execPath = process.execPath,
}: LinuxLaunchOptions = {}): string => {
  const appImage = typeof env.APPIMAGE === 'string' ? env.APPIMAGE.trim() : '';
  if (appImage && path.isAbsolute(appImage)) {
    return appImage;
  }
  return execPath;
};

const quoteDesktopExecArg = (value: unknown): string => {
  const text = String(value ?? '');
  if (!/[ \t\n"$\\]/.test(text)) {
    return text;
  }
  return `"${text.replace(/(["\\$`])/g, '\\$1')}"`;
};

export const buildLinuxAutostartDesktopEntry = ({
  appName = 'Piarium',
  executable,
  backgroundArg,
  env = process.env,
  execPath = process.execPath,
}: LinuxAutostartEntryOptions = {}): string => {
  const launchPath = executable || resolveLinuxLaunchExecutable({ env, execPath });
  const args = [quoteDesktopExecArg(launchPath)];
  if (typeof backgroundArg === 'string' && backgroundArg.trim()) {
    args.push(backgroundArg.trim());
  }
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${appName}`,
    `Exec=${args.join(' ')}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'StartupWMClass=piarium',
    '',
  ].join('\n');
};

export const readLinuxAutostartEnabled = async (options: LinuxAutostartPathsOptions = {}): Promise<boolean> => {
  const filePath = resolveLinuxAutostartFilePath(options);
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

export const setLinuxAutostartEnabled = async ({
  enabled,
  appName = 'Piarium',
  backgroundArg,
  env = process.env,
  execPath = process.execPath,
  homeDir = os.homedir(),
}: SetLinuxAutostartOptions): Promise<{ enabled: boolean; filePath: string; supported: true }> => {
  const directory = resolveLinuxAutostartDirectory({ env, homeDir });
  const filePath = path.join(directory, AUTOSTART_FILE_NAME);

  if (!enabled) {
    await fsp.rm(filePath, { force: true });
    return { supported: true, enabled: false, filePath };
  }

  await fsp.mkdir(directory, { recursive: true });
  const contents = buildLinuxAutostartDesktopEntry({
    appName,
    env,
    execPath,
    ...(backgroundArg !== undefined ? { backgroundArg } : {}),
  });
  await fsp.writeFile(filePath, contents, 'utf8');
  return { supported: true, enabled: true, filePath };
};
