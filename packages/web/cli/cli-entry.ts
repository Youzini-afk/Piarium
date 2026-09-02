import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

type CliRealpath = (filePath: string) => string;

function normalizeCliEntryPath(
  filePath: unknown,
  realpath: CliRealpath = fs.realpathSync,
): string | null {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    return null;
  }

  const resolvedPath = path.resolve(filePath);
  try {
    return realpath(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function isModuleCliExecution(
  entryPath: unknown = process.argv[1],
  moduleUrl?: unknown,
  realpath: CliRealpath = fs.realpathSync,
  expectedBinName?: string,
): boolean {
  if (typeof entryPath !== 'string' || entryPath.trim().length === 0) {
    return false;
  }
  if (typeof moduleUrl !== 'string' || moduleUrl.trim().length === 0) {
    return false;
  }

  try {
    const normalizedEntryPath = normalizeCliEntryPath(entryPath, realpath);
    const normalizedModulePath = normalizeCliEntryPath(fileURLToPath(moduleUrl), realpath);
    if (!normalizedEntryPath || !normalizedModulePath) {
      return false;
    }
    if (pathToFileURL(normalizedEntryPath).href === pathToFileURL(normalizedModulePath).href) {
      return true;
    }

    if (typeof expectedBinName === 'string' && expectedBinName.trim().length > 0) {
      const parsedEntryName = path.parse(normalizedEntryPath).name.toLowerCase();
      return parsedEntryName === expectedBinName.trim().toLowerCase();
    }

    return false;
  } catch {
    return false;
  }
}

export {
  normalizeCliEntryPath,
  isModuleCliExecution,
};
