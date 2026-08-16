import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PI_SDK_PACKAGE_NAMES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
] as const;

export type PiSdkPackageName = (typeof PI_SDK_PACKAGE_NAMES)[number];

const SOURCE_PACKAGE_DIRS: Record<PiSdkPackageName, readonly string[]> = {
  "@earendil-works/pi-coding-agent": ["packages/coding-agent", "packages/pi-coding-agent"],
  "@earendil-works/pi-agent-core": ["packages/agent", "packages/pi-agent-core"],
  "@earendil-works/pi-ai": ["packages/ai", "packages/pi-ai"],
};

export function matchPiSdkPackage(specifier: string): PiSdkPackageName | undefined {
  return PI_SDK_PACKAGE_NAMES.find(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  );
}

function readPackageName(manifestPath: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

export function findSdkPackageDir(packageRoot: string, name: PiSdkPackageName): string | undefined {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const add = (value: string) => {
    const resolved = resolve(value);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    candidates.push(resolved);
  };

  add(packageRoot);
  add(join(packageRoot, "node_modules", ...name.split("/")));
  for (const relativeDir of SOURCE_PACKAGE_DIRS[name]) {
    add(join(packageRoot, relativeDir));
  }

  let current = resolve(packageRoot);
  for (let index = 0; index < 8; index++) {
    add(join(current, "node_modules", ...name.split("/")));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const candidate of candidates) {
    const manifest = join(candidate, "package.json");
    if (!existsSync(manifest)) continue;
    if (readPackageName(manifest) === name) return candidate;
  }
  return undefined;
}

function pickExportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const picked = pickExportTarget(entry);
      if (picked) return picked;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["import", "node", "default"]) {
    const picked = pickExportTarget(record[key]);
    if (picked) return picked;
  }
  return undefined;
}

function matchExportKey(
  exportsMap: Record<string, unknown>,
  subpath: string,
): { pattern: string; replacement: string } | undefined {
  if (exportsMap[subpath] !== undefined) return { pattern: subpath, replacement: "" };
  for (const pattern of Object.keys(exportsMap)) {
    const wildcard = pattern.indexOf("*");
    if (wildcard === -1) continue;
    const prefix = pattern.slice(0, wildcard);
    const suffix = pattern.slice(wildcard + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    const replacement = subpath.slice(prefix.length, subpath.length - suffix.length);
    if (replacement.includes("/")) continue;
    return { pattern, replacement };
  }
  return undefined;
}

export function importerParentURL(packageDir: string, packageName: string): string | undefined {
  const scope = packageName.startsWith("@") ? packageName.split("/")[0] : undefined;
  if (
    scope
    && basename(dirname(packageDir)) === scope
    && basename(dirname(dirname(packageDir))) === "node_modules"
  ) {
    return pathToFileURL(join(dirname(dirname(packageDir)), "piarium-sdk-importer.mjs")).href;
  }
  if (!scope && basename(dirname(packageDir)) === "node_modules") {
    return pathToFileURL(join(dirname(packageDir), "piarium-sdk-importer.mjs")).href;
  }
  return undefined;
}

export function resolveSdkPackageEntry(
  packageDir: string,
  specifier: string,
  packageName: PiSdkPackageName,
): string {
  const manifestPath = join(packageDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    exports?: unknown;
    main?: unknown;
    module?: unknown;
  };
  const subpath = specifier === packageName ? "." : `.${specifier.slice(packageName.length)}`;
  let relativePath: string | undefined;
  if (typeof manifest.exports === "string" && subpath === ".") {
    relativePath = manifest.exports;
  } else if (manifest.exports && typeof manifest.exports === "object") {
    const exportsMap = manifest.exports as Record<string, unknown>;
    const match = matchExportKey(exportsMap, subpath) ?? (subpath === "." ? { pattern: ".", replacement: "" } : undefined);
    const target = match ? exportsMap[match.pattern] : undefined;
    const picked = pickExportTarget(target);
    relativePath = picked && match?.replacement
      ? picked.replaceAll("*", match.replacement)
      : picked;
  }
  if (relativePath === undefined && subpath === ".") {
    relativePath =
      typeof manifest.module === "string"
        ? manifest.module
        : typeof manifest.main === "string"
          ? manifest.main
          : "index.js";
  }
  if (!relativePath) {
    throw new Error(`Unable to resolve ${specifier} from ${packageDir}`);
  }
  const absolute = resolve(packageDir, relativePath);
  if (!existsSync(absolute)) {
    throw new Error(`Resolved ${specifier} to missing file ${absolute}`);
  }
  return pathToFileURL(absolute).href;
}

export function resolvePiSdkSpecifier(packageRoot: string, specifier: string): string {
  const name = matchPiSdkPackage(specifier);
  if (!name) {
    throw new Error(`Not a Pi SDK specifier: ${specifier}`);
  }
  const packageDir = findSdkPackageDir(packageRoot, name);
  if (!packageDir) {
    throw new Error(`Unable to resolve ${specifier} from Pi package root ${packageRoot}`);
  }
  return resolveSdkPackageEntry(packageDir, specifier, name);
}

export function listMissingPiSdkPackages(packageRoot: string): string[] {
  return PI_SDK_PACKAGE_NAMES.filter((name) => findSdkPackageDir(packageRoot, name) === undefined);
}

export function assertPiSdkResolvable(packageRoot: string): void {
  const missing = listMissingPiSdkPackages(packageRoot);
  if (missing.length > 0) {
    throw new Error(`Pi package root is missing required modules: ${missing.join(", ")}`);
  }
}

export function resolvePiPackageFromCommand(commandPath: string): {
  issue?: string;
  nodePath?: string;
  packageRoot?: string;
} {
  const resolvedCommand = resolve(commandPath);
  let nodePath: string | undefined;
  try {
    const header = readFileSync(resolvedCommand, "utf8").slice(0, 512);
    const shebang = header.match(/^#!\s*([^\r\n]+)/);
    const interpreter = shebang?.[1]?.trim().split(/\s+/).at(-1);
    if (interpreter && /node(?:\.exe)?$/i.test(interpreter)) {
      nodePath = interpreter === "node" || interpreter === "node.exe" ? undefined : interpreter;
    }
  } catch {
    // Binary shims have no shebang; keep walking the install layout.
  }

  const searchRoots = [
    dirname(resolvedCommand),
    join(dirname(resolvedCommand), ".."),
    join(dirname(resolvedCommand), "..", "lib"),
    join(dirname(resolvedCommand), "..", "install", "global"),
  ];
  for (const root of searchRoots) {
    const candidate = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
    if (existsSync(join(candidate, "package.json")) && readPackageName(join(candidate, "package.json")) === "@earendil-works/pi-coding-agent") {
      return {
        packageRoot: resolve(candidate),
        ...(nodePath === undefined ? {} : { nodePath }),
      };
    }
  }
  return {
    ...(nodePath === undefined ? {} : { nodePath }),
    issue: "Pi package root could not be resolved from the command",
  };
}
