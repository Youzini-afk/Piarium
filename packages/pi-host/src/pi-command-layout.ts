import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { resolvePiPackageFromCommand } from "./pi-sdk-packages.js";

export interface ResolvedPiCommand {
  commandPath: string;
  issue?: string;
  nodePath?: string;
  packageRoot?: string;
}

const CODING_AGENT = "@earendil-works/pi-coding-agent";

function readPackageName(manifestPath: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

function packageRootFromPath(candidate: string): string | undefined {
  let current = resolve(candidate);
  for (let index = 0; index < 10; index++) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest) && readPackageName(manifest) === CODING_AGENT) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate));
}

function unescapeShimPath(value: string): string {
  return value.replaceAll('""', '"').replaceAll("^%", "%").trim();
}

function collectQuotedPaths(text: string): string[] {
  const matches = text.matchAll(/"([^"\r\n]+)"/g);
  return [...matches].map((match) => unescapeShimPath(match[1] ?? "")).filter(Boolean);
}

function expandShimVariables(value: string, commandPath: string): string {
  const directory = dirname(commandPath);
  return value
    .replaceAll("%~dp0", `${directory}\\`)
    .replaceAll("%dp0%", `${directory}\\`)
    .replaceAll("%dp0", `${directory}\\`)
    .replaceAll("$basedir", directory)
    .replaceAll("$DIR", directory)
    .replaceAll(/\$\{?basedir\}?/g, directory);
}

function resolveMaybeRelative(value: string, commandPath: string): string {
  const expanded = expandShimVariables(value, commandPath);
  const nativePath = sep === "\\"
    ? expanded.replaceAll("/", "\\")
    : expanded.replaceAll("\\", "/");
  return isAbsolute(nativePath) ? resolve(nativePath) : resolve(dirname(commandPath), nativePath);
}

function readTextHeader(path: string): string | undefined {
  try {
    const handle = readFileSync(path);
    if (handle.includes(0)) return undefined;
    return handle.toString("utf8");
  } catch {
    return undefined;
  }
}

function resolveSymlinkTarget(commandPath: string): string | undefined {
  try {
    const stat = lstatSync(commandPath);
    if (stat.isSymbolicLink() || stat.isFile()) {
      return realpathSync(commandPath);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function nodeBesideCommand(commandPath: string): string | undefined {
  const directory = dirname(commandPath);
  return firstExisting([
    join(directory, "node.exe"),
    join(directory, "node"),
    join(directory, "..", "node.exe"),
    join(directory, "..", "bin", "node"),
    join(directory, "..", "bin", "node.exe"),
  ]);
}

function parseShebang(text: string): string | undefined {
  const line = text.match(/^#!\s*([^\r\n]+)/)?.[1]?.trim();
  if (!line) return undefined;
  const parts = line.split(/\s+/);
  const interpreter = parts.at(-1);
  if (
    interpreter
    && /node(?:\.exe)?$/i.test(interpreter)
    && (interpreter.includes("/") || interpreter.includes("\\"))
  ) {
    return interpreter;
  }
  if (parts[0] && /node(?:\.exe)?$/i.test(parts[0]) && (parts[0].includes("/") || parts[0].includes("\\"))) {
    return parts[0];
  }
  return undefined;
}

function parseShimLayout(commandPath: string, text: string): ResolvedPiCommand {
  const paths = collectQuotedPaths(text).map((entry) => resolveMaybeRelative(entry, commandPath));
  const script = paths.find((entry) => /pi-coding-agent/i.test(entry) || /cli\.js$/i.test(entry));
  const nodePath =
    paths.find((entry) => /node(?:\.exe)?$/i.test(entry) && existsSync(entry))
    ?? nodeBesideCommand(commandPath);
  const packageRoot = script ? packageRootFromPath(script) : undefined;
  if (packageRoot) {
    return {
      commandPath,
      packageRoot,
      ...(nodePath === undefined ? {} : { nodePath }),
    };
  }
  return {
    commandPath,
    ...(nodePath === undefined ? {} : { nodePath }),
    issue: "Pi package root could not be resolved from the command shim",
  };
}

export function resolvePiCommandLayout(commandPath: string): ResolvedPiCommand {
  const resolvedCommand = resolve(commandPath);
  const fallback = resolvePiPackageFromCommand(resolvedCommand);
  if (fallback.packageRoot) {
    const nodePath = fallback.nodePath ?? nodeBesideCommand(resolvedCommand);
    return {
      commandPath: resolvedCommand,
      packageRoot: fallback.packageRoot,
      ...(nodePath === undefined ? {} : { nodePath }),
    };
  }

  const target = resolveSymlinkTarget(resolvedCommand);
  if (target && target !== resolvedCommand) {
    const fromTarget = packageRootFromPath(target);
    if (fromTarget) {
      const nodePath = nodeBesideCommand(resolvedCommand);
      return {
        commandPath: resolvedCommand,
        packageRoot: fromTarget,
        ...(nodePath === undefined ? {} : { nodePath }),
      };
    }
  }

  const text = readTextHeader(resolvedCommand);
  if (text) {
    const shebangNode = parseShebang(text);
    const fromShim = parseShimLayout(resolvedCommand, text);
    if (fromShim.packageRoot) {
      return {
        ...fromShim,
        ...(fromShim.nodePath === undefined && shebangNode ? { nodePath: shebangNode } : {}),
      };
    }
    const fromFallback = resolvePiPackageFromCommand(resolvedCommand);
    if (fromFallback.packageRoot) {
      const nodePath = fromFallback.nodePath ?? shebangNode;
      return {
        commandPath: resolvedCommand,
        packageRoot: fromFallback.packageRoot,
        ...(nodePath === undefined ? {} : { nodePath }),
      };
    }
    const issue = fromShim.issue ?? fallback.issue;
    return {
      commandPath: resolvedCommand,
      ...(shebangNode === undefined ? {} : { nodePath: shebangNode }),
      ...(fromShim.nodePath === undefined ? {} : { nodePath: fromShim.nodePath }),
      ...(issue === undefined ? {} : { issue }),
    };
  }

  return {
    commandPath: resolvedCommand,
    ...(fallback.nodePath === undefined ? {} : { nodePath: fallback.nodePath }),
    issue: fallback.issue ?? "Pi package root could not be resolved from the command",
  };
}

export function isStandalonePiLayout(packageRoot: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const normalized = resolve(packageRoot).toLowerCase();
  const markers: string[] = [];
  if (env.LOCALAPPDATA) markers.push(join(env.LOCALAPPDATA, "Pi", "runtime"));
  if (env.XDG_DATA_HOME) markers.push(join(env.XDG_DATA_HOME, "pi", "runtime"));
  if (env.HOME) {
    markers.push(join(env.HOME, ".local", "share", "pi", "runtime"));
    markers.push(join(env.HOME, ".pi", "runtime"));
  }
  return markers
    .map((entry) => resolve(entry).toLowerCase())
    .some((marker) => marker && normalized.startsWith(marker));
}

export function commandLooksLikeWindowsShim(commandPath: string): boolean {
  return [".cmd", ".bat", ".ps1"].includes(extname(commandPath).toLowerCase())
    || basename(commandPath).toLowerCase() === "pi";
}
