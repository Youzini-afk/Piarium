import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID,
  PIARIUM_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_ID,
} from "./index.js";

const ASAR_DIRECTORY_SEGMENT = /(^|[\\/])([^\\/]+\.asar)([\\/])/i;

/**
 * Electron keeps the logical module URL inside app.asar even when electron-builder
 * physically unpacks runtime files beside it. Built-in packages are copied into an
 * immutable artifact before execution, so their registered roots must name the
 * physical directory rather than an ASAR virtual directory.
 */
export const resolvePiariumBuiltinPackageRoot = (
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

export const PIARIUM_BUILTIN_EXTENSION_PACKAGE_ROOTS: ReadonlyMap<string, string> = new Map([
  [
    PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID,
    resolvePiariumBuiltinPackageRoot(
      fileURLToPath(new URL("./builtin-packages/typescript-language/", import.meta.url)),
    ),
  ],
  [
    PIARIUM_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_ID,
    resolvePiariumBuiltinPackageRoot(
      fileURLToPath(new URL("./builtin-packages/recovery/", import.meta.url)),
    ),
  ],
]);
