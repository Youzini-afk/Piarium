import type { InitializeHook, ResolveHook } from "node:module";
import {
  findSdkPackageDir,
  importerParentURL,
  matchPiSdkPackage,
  resolvePiSdkSpecifier,
} from "./pi-sdk-packages.js";

let packageRoot: string | undefined;

export const initialize: InitializeHook<{ packageRoot?: string }> = (data) => {
  packageRoot = typeof data?.packageRoot === "string" && data.packageRoot.trim()
    ? data.packageRoot
    : undefined;
};

export const resolve: ResolveHook = async (specifier, context, nextResolve) => {
  const name = matchPiSdkPackage(specifier);
  if (!packageRoot || !name) {
    return nextResolve(specifier, context);
  }
  const packageDir = findSdkPackageDir(packageRoot, name);
  if (!packageDir) {
    throw new Error(`Unable to resolve ${specifier} from Pi package root ${packageRoot}`);
  }
  const importer = importerParentURL(packageDir, name);
  if (importer) {
    return nextResolve(specifier, { ...context, parentURL: importer });
  }
  try {
    return {
      format: "module",
      shortCircuit: true,
      url: resolvePiSdkSpecifier(packageRoot, specifier),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message, { cause: error });
  }
};
