import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { PiConfigTextAuthorityId } from "@piarium/protocol";
import { HostError } from "./errors.js";

const PI_LENS_PROJECT_CONFIG_NAMES = [".pi-lens.json", "pi-lens.json"] as const;

export interface ResolvedConfigTextAuthority {
  authority: PiConfigTextAuthorityId;
  path: string;
  watchPaths: readonly string[];
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

export async function resolveConfigTextAuthority(
  authority: PiConfigTextAuthorityId,
  cwd: string,
): Promise<ResolvedConfigTextAuthority> {
  if (authority === "pi-lens-global") {
    const path = piLensGlobalConfigPath();
    await pathStatus(path);
    return { authority, path, watchPaths: [path] };
  }

  const watchPaths = piLensProjectCandidates(cwd);
  for (const path of watchPaths) {
    if (await pathStatus(path) === "present") return { authority, path, watchPaths };
  }
  return { authority, path: watchPaths[0] as string, watchPaths };
}
