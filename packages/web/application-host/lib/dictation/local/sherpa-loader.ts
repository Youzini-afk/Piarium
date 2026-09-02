/**
 * Loader for the sherpa-onnx-node native addon.
 *
 * sherpa-onnx-node ships its native addon and shared libraries in a
 * platform-specific package (e.g. sherpa-onnx-darwin-arm64). The shared
 * libraries must be findable via the platform's dynamic-loader search path,
 * so the loader prepends the platform package directory to LD_LIBRARY_PATH /
 * DYLD_LIBRARY_PATH / PATH before requiring the addon.
 */

import { createRequire } from 'module';
import path from 'path';
import { existsSync } from 'fs';
import type { SherpaModule } from '../types.js';

const require = createRequire(import.meta.url);

let cached: SherpaModule | null = null;

function sherpaPlatformPackageName(platform: NodeJS.Platform | string = process.platform, arch = process.arch): string {
  const normalizedPlatform = platform === 'win32' ? 'win' : platform;
  return `sherpa-onnx-${normalizedPlatform}-${arch}`;
}

function sherpaLoaderEnvKey(platform: NodeJS.Platform | string = process.platform): string | null {
  if (platform === 'linux') {
    return 'LD_LIBRARY_PATH';
  }
  if (platform === 'darwin') {
    return 'DYLD_LIBRARY_PATH';
  }
  if (platform === 'win32') {
    return 'PATH';
  }
  return null;
}

function prependEnvPath(existing: string | undefined, value: string): string {
  const parts = String(existing ?? '').split(path.delimiter).filter(Boolean);
  if (parts.includes(value)) {
    return parts.join(path.delimiter);
  }
  return [value, ...parts].join(path.delimiter);
}

/**
 * Case-insensitive env key lookup: on Windows `{...process.env}` yields a
 * plain object where PATH may be stored as `Path`. Using a hardcoded 'PATH'
 * would create a duplicate key and break the child process PATH.
 */
function findEnvKey(env: NodeJS.ProcessEnv, key: string): string {
  const lower = key.toLowerCase();
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === lower) {
      return k;
    }
  }
  return key;
}

function resolveSherpaLibDir(platform: NodeJS.Platform | string = process.platform, arch = process.arch): string | null {
  const packageName = sherpaPlatformPackageName(platform, arch);
  try {
    const pkgJson = require.resolve(`${packageName}/package.json`);
    // Electron packages node_modules inside app.asar, but native addons and
    // their shared libraries are extracted to app.asar.unpacked. The dynamic
    // loader (dlopen/DYLD/LD) cannot read from the asar archive, so point the
    // search path at the unpacked copy.
    const dir = path.dirname(pkgJson);
    const unpacked = dir.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    return existsSync(unpacked) ? unpacked : dir;
  } catch {
    return null;
  }
}

/**
 * Prepend the sherpa platform package dir to the loader search path env var.
 * Mutates the provided env object.
 * @param {NodeJS.ProcessEnv} env
 */
export function applySherpaLoaderEnv(env: NodeJS.ProcessEnv): { key: string | null; libDir: string | null } {
  const key = sherpaLoaderEnvKey();
  const libDir = resolveSherpaLibDir();
  if (!key || !libDir) {
    return { key: null, libDir: null };
  }
  const actualKey = findEnvKey(env, key);
  env[actualKey] = prependEnvPath(env[actualKey], libDir);
  return { key, libDir };
}

/**
 * Load the sherpa-onnx-node module, trying the upstream entry first and then
 * the platform addon directly.
 */
const parseSherpaModule = (value: unknown): SherpaModule => {
  if (!value || typeof value !== 'object') throw new Error('sherpa-onnx-node returned an invalid module');
  const module = value as Record<string, unknown>;
  if (typeof module.OfflineRecognizer !== 'function') {
    throw new Error('sherpa-onnx-node is missing OfflineRecognizer');
  }
  return module as unknown as SherpaModule;
};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function loadSherpaOnnxNode(): SherpaModule {
  if (cached) {
    return cached;
  }

  const attempts = [];

  try {
    cached = parseSherpaModule(require('sherpa-onnx-node'));
    return cached;
  } catch (error) {
    attempts.push(`sherpa-onnx-node: ${errorMessage(error)}`);
  }

  const libDir = resolveSherpaLibDir();
  if (libDir) {
    applySherpaLoaderEnv(process.env);
    const addonPath = path.join(libDir, 'sherpa-onnx.node');
    if (existsSync(addonPath)) {
      try {
        cached = parseSherpaModule(require(addonPath));
        return cached;
      } catch (error) {
        attempts.push(`${addonPath}: ${errorMessage(error)}`);
      }
    } else {
      attempts.push(`${addonPath}: file not found`);
    }
  } else {
    attempts.push(`${sherpaPlatformPackageName()}: platform package not installed`);
  }

  throw new Error(
    [
      `Failed to load sherpa-onnx-node for ${process.platform}-${process.arch}.`,
      `Node ${process.version} (ABI ${process.versions.modules}).`,
      'Load attempts:',
      ...attempts.map((line) => `- ${line}`),
    ].join('\n'),
  );
}
