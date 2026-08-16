import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type PiPackageManagerKind = "npm" | "bun" | "pnpm";

export interface DetectedPackageManager {
  kind: PiPackageManagerKind;
  executable: string;
}

export interface PackageManagerDetectionOptions {
  env?: NodeJS.ProcessEnv;
  findCommands(name: string): Promise<string[]>;
  platform?: NodeJS.Platform;
}

const MANAGER_COMMANDS: Record<PiPackageManagerKind, readonly string[]> = {
  bun: ["bun"],
  npm: ["npm"],
  pnpm: ["pnpm"],
};

function windowsManagerPriority(command: string): number {
  const lower = command.toLowerCase();
  if (lower.endsWith(".exe")) return 0;
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) return 1;
  if (lower.endsWith(".ps1")) return 2;
  return 3;
}

export function detectOwningPackageManager(
  paths: Array<string | undefined>,
): PiPackageManagerKind | undefined {
  const haystack = paths.filter((entry): entry is string => Boolean(entry)).join("\n").toLowerCase();
  if (haystack.includes(`${join(".bun", "install", "global")}`.toLowerCase()) || haystack.includes("/.bun/") || haystack.includes("\\.bun\\")) {
    return "bun";
  }
  if (haystack.includes("pnpm") || haystack.includes(".local/share/pnpm") || haystack.includes("\\pnpm\\")) {
    return "pnpm";
  }
  if (haystack.includes("roaming\\npm") || haystack.includes("/npm/") || haystack.includes("\\npm\\")) {
    return "npm";
  }
  return undefined;
}

export async function detectPackageManagers(
  options: PackageManagerDetectionOptions,
): Promise<DetectedPackageManager[]> {
  const platform = options.platform ?? process.platform;
  const detected: DetectedPackageManager[] = [];
  for (const kind of ["bun", "npm", "pnpm"] as const) {
    const names = platform === "win32"
      ? MANAGER_COMMANDS[kind].flatMap((name) => [`${name}.cmd`, name, `${name}.exe`])
      : [...MANAGER_COMMANDS[kind]];
    const found: string[] = [];
    for (const name of names) {
      found.push(...(await options.findCommands(name)));
    }
    const unique = [...new Set(found.filter((entry) => existsSync(entry) || platform !== "win32"))];
    const executable = platform === "win32"
      ? unique.toSorted((left, right) => windowsManagerPriority(left) - windowsManagerPriority(right))[0]
      : unique[0];
    if (executable) detected.push({ kind, executable });
  }
  return detected;
}

export function globalInstallArguments(
  kind: PiPackageManagerKind,
  packageSpec: string,
): string[] {
  if (kind === "npm") return ["install", "-g", packageSpec];
  return ["add", "-g", packageSpec];
}

export function inferGlobalPrefix(executable: string, kind: PiPackageManagerKind): string | undefined {
  const directory = dirname(resolve(executable));
  if (kind === "bun") {
    const prefix = join(directory, "..", "install", "global");
    return existsSync(prefix) ? resolve(prefix) : undefined;
  }
  if (kind === "npm") {
    return directory;
  }
  return directory;
}
