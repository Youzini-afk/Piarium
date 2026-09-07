import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Same remapping as `packages/extension-builtins/src/host.ts`.
 * Electron may leave the logical path inside `app.asar` while the unpacked
 * bytes live in `app.asar.unpacked`.
 */
const ASAR_DIRECTORY_SEGMENT = /(^|[\\/])([^\\/]+\.asar)([\\/])/i;

export const remapAsarUnpackedPath = (
  sourcePath: string,
  pathExists: (candidate: string) => boolean = existsSync,
): string => {
  const unpackedPath = sourcePath.replace(
    ASAR_DIRECTORY_SEGMENT,
    (_segment, prefix: string, archive: string, separator: string) => (
      `${prefix}${archive}.unpacked${separator}`
    ),
  );
  if (unpackedPath === sourcePath || !pathExists(unpackedPath)) return sourcePath;
  return unpackedPath;
};

export const resolveStructureRuntimeFile = (
  fileName: string,
  fromUrl: string = import.meta.url,
  pathExists: (candidate: string) => boolean = existsSync,
  resolveInstalled?: (candidate: string) => string | null,
): string => {
  const bundled = remapAsarUnpackedPath(fileURLToPath(new URL(`./runtime/${fileName}`, fromUrl)), pathExists);
  if (pathExists(bundled)) return bundled;
  const installed = resolveInstalled?.(fileName);
  if (installed && pathExists(installed)) return installed;
  return bundled;
};
