import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";
import { createPlatformEnvironmentRuntime } from "../platform/environment-runtime.js";
import type { DiscoveredShells } from "./shell-supervisor.js";

export interface DiscoverShellsDeps {
  env?: NodeJS.ProcessEnv;
  pathModule?: Pick<typeof path, "join" | "dirname" | "isAbsolute" | "delimiter">;
  platform?: NodeJS.Platform;
  runtime?: {
    isExecutable: (filePath: unknown) => filePath is string;
    searchPathFor: (binaryName: unknown, searchPath?: string) => string | null;
    resolveGitBinaryForSpawn?: () => string;
  };
  spawnSyncFn?: (
    command: string,
    args: readonly string[],
    options: { encoding: "buffer"; windowsHide?: boolean },
  ) => Pick<SpawnSyncReturns<Buffer>, "status" | "stdout">;
}

const WINDOWS_GIT_BASH_SUFFIXES = [
  ["Git", "usr", "bin", "bash.exe"],
  ["Git", "bin", "bash.exe"],
  ["Programs", "Git", "usr", "bin", "bash.exe"],
  ["Programs", "Git", "bin", "bash.exe"],
] as const;

/** Same program roots the Git service and environment runtime already search. */
export const listWindowsProgramRoots = (
  env: NodeJS.ProcessEnv = process.env,
): string[] => (
  [env.ProgramFiles, env["ProgramFiles(x86)"], env.LocalAppData]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
);

const preferGitBashExecutable = (
  candidate: string,
  isExecutable: (filePath: unknown) => filePath is string,
  _pathModule: Pick<typeof path, "join" | "dirname">,
): string | undefined => {
  if (!isExecutable(candidate)) return undefined;
  const unified = candidate.replace(/\//g, "\\");
  if (/\\usr\\bin\\bash\.exe$/i.test(unified)) return candidate;
  const usrSibling = candidate.replace(/[\\/]bin[\\/]bash\.exe$/i, (match) => (
    match.includes("/") ? "/usr/bin/bash.exe" : "\\usr\\bin\\bash.exe"
  ));
  if (usrSibling !== candidate && isExecutable(usrSibling)) return usrSibling;
  return candidate;
};

const bashBesideGitBinary = (
  gitBinary: string,
  isExecutable: (filePath: unknown) => filePath is string,
  pathModule: Pick<typeof path, "join" | "dirname" | "isAbsolute">,
): string | undefined => {
  if (!pathModule.isAbsolute(gitBinary) || !isExecutable(gitBinary)) return undefined;
  const gitHome = pathModule.dirname(pathModule.dirname(gitBinary));
  for (const suffix of [["usr", "bin", "bash.exe"], ["bin", "bash.exe"]] as const) {
    const found = preferGitBashExecutable(pathModule.join(gitHome, ...suffix), isExecutable, pathModule);
    if (found) return found;
  }
  return undefined;
};

const decodeProcessOutput = (stdout: Buffer): string => {
  if (stdout.length >= 2 && stdout[0] === 0xFF && stdout[1] === 0xFE) {
    return stdout.toString("utf16le");
  }
  if (stdout.length >= 2 && stdout[0] === 0xFE && stdout[1] === 0xFF) {
    return stdout.swap16().toString("utf16le");
  }
  if (stdout.includes(0)) return stdout.toString("utf16le");
  return stdout.toString("utf8");
};

export const parseWslDistroList = (stdout: Buffer | string): string[] => {
  const text = typeof stdout === "string" ? stdout : decodeProcessOutput(stdout);
  const seen = new Set<string>();
  const distros: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const name = line.replace(/\u0000/g, "").replace(/^\uFEFF/, "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    distros.push(name);
  }
  return distros;
};

const listWslDistros = (
  searchPathFor: (binaryName: unknown) => string | null,
  spawn: NonNullable<DiscoverShellsDeps["spawnSyncFn"]>,
): string[] => {
  const wsl = searchPathFor("wsl") ?? "wsl.exe";
  try {
    const result = spawn(wsl, ["--list", "--quiet"], { encoding: "buffer", windowsHide: true });
    if (result.status !== 0) return [];
    return parseWslDistroList(result.stdout);
  } catch {
    return [];
  }
};

/**
 * Machine-level interpreter discovery. Production Host construction calls this
 * once; session registration only combines it with that workspace's
 * `harness.shell`. Tests may inject filesystem and PATH seams.
 */
export function discoverShells(deps: DiscoverShellsDeps = {}): DiscoveredShells {
  const env = deps.env ?? process.env;
  const pathModule = deps.pathModule ?? path;
  const platform = deps.platform ?? process.platform;
  const runtime = deps.runtime ?? createPlatformEnvironmentRuntime({
    pathModule: pathModule as typeof path,
    processLike: { ...process, env, platform } as NodeJS.Process,
    ...(deps.spawnSyncFn ? { spawnSyncFn: deps.spawnSyncFn as typeof spawnSync } : {}),
  });
  const spawn = deps.spawnSyncFn ?? ((command, args, options) => spawnSync(command, [...args], options));

  if (platform !== "win32") {
    return {
      hasBash: runtime.searchPathFor("bash") !== null,
      hasPowerShell: runtime.searchPathFor("pwsh") !== null || runtime.searchPathFor("powershell") !== null,
    };
  }

  const candidates: string[] = [];
  for (const root of listWindowsProgramRoots(env)) {
    for (const suffix of WINDOWS_GIT_BASH_SUFFIXES) {
      candidates.push(pathModule.join(root, ...suffix));
    }
  }
  const fromPath = runtime.searchPathFor("bash");
  if (fromPath) candidates.push(fromPath);
  const fromGit = runtime.resolveGitBinaryForSpawn?.();
  if (fromGit) {
    const beside = bashBesideGitBinary(fromGit, runtime.isExecutable, pathModule);
    if (beside) candidates.push(beside);
  }

  let gitBashPath: string | undefined;
  for (const candidate of candidates) {
    const resolved = preferGitBashExecutable(candidate, runtime.isExecutable, pathModule);
    if (!resolved) continue;
    gitBashPath = resolved;
    break;
  }

  const systemPowerShell = pathModule.join(
    env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const hasPowerShell = runtime.searchPathFor("pwsh") !== null
    || runtime.searchPathFor("powershell") !== null
    || runtime.isExecutable(systemPowerShell);

  return {
    ...(gitBashPath ? { gitBashPath } : {}),
    wslDistros: listWslDistros(runtime.searchPathFor, spawn),
    hasBash: gitBashPath !== undefined || fromPath !== null,
    hasPowerShell,
  };
}
