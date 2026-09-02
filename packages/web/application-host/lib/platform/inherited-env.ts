import { existsSync } from 'node:fs';

const LINUX_ENV_BINARIES = ['/usr/bin/env', '/bin/env'];

export function stripAppImageArgv0Leak<T>(env: T): T {
  if (!env || typeof env !== 'object') return env;
  delete (env as T & { ARGV0?: unknown }).ARGV0;
  return env;
}

export function clearAppImageArgv0FromProcessEnv(): void {
  delete process.env.ARGV0;
}

export function resolveLinuxPtyLaunch(
  executable: string,
  args: readonly string[] = [],
): { executable: string; args: string[] } {
  if (process.platform !== 'linux') return { executable, args: [...args] };
  const envBinary = LINUX_ENV_BINARIES.find((candidate) => existsSync(candidate));
  return envBinary
    ? { executable: envBinary, args: ['-u', 'ARGV0', executable, ...args] }
    : { executable, args: [...args] };
}
