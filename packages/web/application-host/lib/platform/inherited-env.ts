// @ts-nocheck
import { existsSync } from 'node:fs';

const LINUX_ENV_BINARIES = ['/usr/bin/env', '/bin/env'];

export function stripAppImageArgv0Leak(env) {
  if (!env || typeof env !== 'object') return env;
  delete env.ARGV0;
  return env;
}

export function clearAppImageArgv0FromProcessEnv() {
  delete process.env.ARGV0;
}

export function resolveLinuxPtyLaunch(executable, args = []) {
  if (process.platform !== 'linux') return { executable, args };
  const envBinary = LINUX_ENV_BINARIES.find((candidate) => existsSync(candidate));
  return envBinary
    ? { executable: envBinary, args: ['-u', 'ARGV0', executable, ...args] }
    : { executable, args };
}
