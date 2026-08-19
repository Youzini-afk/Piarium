import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import type { PiConfigTextAuthorityId, PiConfigTextFormat } from "@piarium/protocol";
import { HostError } from "./errors.js";

const PI_LENS_PROJECT_CONFIG_NAMES = [".pi-lens.json", "pi-lens.json"] as const;

export interface ResolvedConfigTextAuthority {
  authority: PiConfigTextAuthorityId;
  format: PiConfigTextFormat;
  path: string;
  watchPaths: readonly string[];
}

export interface ConfigTextAuthorityResolverDependencies {
  env: Readonly<{
    HOME?: string;
    USERPROFILE?: string;
    XDG_CONFIG_HOME?: string;
  }>;
  homedir: () => string;
  platform: NodeJS.Platform;
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT"
  );
}

async function pathStatus(path: string): Promise<"missing" | "present"> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new HostError(
        "invalid_config_path",
        "Configuration authority cannot be a symbolic link",
      );
    }
    return "present";
  } catch (error) {
    if (isMissingPathError(error)) return "missing";
    throw error;
  }
}

function piLensGlobalConfigPath(): string {
  const configured = process.env.PI_LENS_CONFIG_PATH;
  return configured
    ? resolve(configured)
    : join(homedir(), ".pi-lens", "config.json");
}

function piLensProjectCandidates(cwd: string): string[] {
  const candidates: string[] = [];
  let directory = resolve(cwd);
  while (true) {
    for (const name of PI_LENS_PROJECT_CONFIG_NAMES) candidates.push(join(directory, name));
    const parent = dirname(directory);
    if (parent === directory) return candidates;
    directory = parent;
  }
}

function resolverDependencies(): ConfigTextAuthorityResolverDependencies {
  return { env: process.env, homedir, platform: process.platform };
}

export function resolveAftUserConfigPath(
  dependencies: ConfigTextAuthorityResolverDependencies = resolverDependencies(),
): string {
  const pathApi = dependencies.platform === "win32" ? win32 : posix;
  const home = dependencies.platform === "win32"
    ? dependencies.env.USERPROFILE || dependencies.env.HOME || dependencies.homedir()
    : dependencies.env.HOME || dependencies.homedir();
  const xdg = dependencies.env.XDG_CONFIG_HOME;
  const configHome = xdg && pathApi.isAbsolute(xdg)
    ? xdg
    : pathApi.join(home, ".config");
  return pathApi.resolve(pathApi.join(configHome, "cortexkit", "aft.jsonc"));
}

export async function resolveConfigTextAuthority(
  authority: PiConfigTextAuthorityId,
  cwd: string,
  agentDir: string,
  dependencies: ConfigTextAuthorityResolverDependencies = resolverDependencies(),
): Promise<ResolvedConfigTextAuthority> {
  if (authority === "pi-lens-global") {
    const path = piLensGlobalConfigPath();
    await pathStatus(path);
    return { authority, format: "json", path, watchPaths: [path] };
  }

  if (authority === "aft-user") {
    const path = resolveAftUserConfigPath(dependencies);
    await pathStatus(path);
    return { authority, format: "jsonc", path, watchPaths: [path] };
  }

  if (authority === "hermes-memory-user") {
    const trimmed = agentDir.trim();
    if (trimmed.length === 0) {
      throw new HostError(
        "invalid_params",
        "Hermes Memory authority requires an agent directory",
      );
    }
    const path = join(resolve(trimmed), "hermes-memory-config.json");
    await pathStatus(path);
    return { authority, format: "json", path, watchPaths: [path] };
  }

  const watchPaths = piLensProjectCandidates(cwd);
  for (const path of watchPaths) {
    if (await pathStatus(path) === "present") {
      return { authority, format: "json", path, watchPaths };
    }
  }
  return { authority, format: "json", path: watchPaths[0] as string, watchPaths };
}
